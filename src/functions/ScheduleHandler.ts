import { app, InvocationContext } from "@azure/functions";
import { ServiceBusClient } from "@azure/service-bus";

import * as cronParser from 'cron-parser';

import { ENVS }                                                     from "./envs";
import { PayloadRecurrent, Workflow, PrepareExecutionResponse }     from "./payloadEmail.model";
import apiRequest, { isApiError, METHOD }                           from "./fetch.service";
import { templateCache }                                            from "./EmailProcessor";


export async function ScheduleHandler(
    message: PayloadRecurrent,
    context: InvocationContext
): Promise<void> {
    const { workflowId, cronRule, sendEmailLogId } = message;

    context.log( `⏰ Iniciando proceso para Workflow ID: ${workflowId} | SendEmailLog: ${sendEmailLogId}` );

    const sbClient = new ServiceBusClient( ENVS.SERVICE_BUS_CONNECTION );

    try {
        const backendUrl = ENVS.MAIL_STUDIO.BACKEND_URL;

        // 1. Obtener datos completos del Workflow
        context.log( `🔗 Solicitando datos al backend: ${backendUrl}/workflow/${workflowId}` );

        const workflow = await apiRequest<Workflow>({
            endpoint: `${backendUrl}/workflow/${workflowId}`,
        });

        if ( isApiError( workflow )) {
            throw new Error( "Workflow no encontrado" );
        }

        // 2. Verificar que el workflow siga activo
        if ( !workflow.active ) {
            context.log( `🛑 Workflow ${workflowId} desactivado por el admin. Terminando ciclo.` );
            return;
        }

        const { students, template, subject, cc, bcc } = workflow;

        if ( !students || !Array.isArray( students ) ) {
            throw new Error( "El backend no devolvió una lista de estudiantes válida." );
        }

        // 3. Cachear template
        templateCache.set( template.id, template.content );

        // 4. Encolar emails individuales en la cola principal
        const emailSender = sbClient.createSender( ENVS.QUEUE.NAME );

        let batch = await emailSender.createMessageBatch();

        context.log( `📦 Encolando ${students.length} mensajes en ${ENVS.QUEUE.NAME}...` );

        for ( let i = 0; i < students.length; i++ ) {
            const emailPayload = {
                body: {
                    student        : students[ i ],
                    templateId     : template.id,
                    subject,
                    notificationId : sendEmailLogId,
                    cc,
                    bcc,
                },
                contentType: 'application/json'
            };

            if ( !batch.tryAddMessage( emailPayload )) {
                await emailSender.sendMessages( batch );

                batch = await emailSender.createMessageBatch();

                if ( !batch.tryAddMessage( emailPayload ) ) {
                    context.log( `⚠️ Saltando correo en índice ${i}: El mensaje excede el límite de tamaño.` );
                    continue;
                }
            }
        }

        await emailSender.sendMessages( batch );
        await emailSender.close();
        context.log( `✅ Encolamiento masivo completado exitosamente.` );

        // 5. Determinar si debe re-programarse
        const isOnce = workflow.frequency === 'ONCE';

        if ( isOnce ) {
            context.log( `📌 Workflow ONCE completado. No se re-programa.` );
            return;
        }

        // 6. Pedir al backend que prepare la próxima ejecución (crea nuevo SendEmailLog + verifica límites)
        context.log( `🔄 Solicitando preparación de próxima ejecución...` );

        const prepareResult = await apiRequest<PrepareExecutionResponse>({
            endpoint : `${backendUrl}/workflow/${workflowId}/prepare-execution`,
            method   : METHOD.POST,
        });

        if ( isApiError( prepareResult )) {
            throw new Error( `Error al preparar próxima ejecución: ${prepareResult.message}` );
        }

        if ( prepareResult.shouldStop ) {
            context.log( `🛑 Recurrencia finalizada: ${prepareResult.reason}` );
            return;
        }

        // 7. Calcular próxima fecha de ejecución
        let nextRun: Date;

        if ( workflow.lastDayOfMonth ) {
            // Cálculo manual para el último día del mes
            const now        = new Date();
            let targetYear   = now.getFullYear();
            let targetMonth  = now.getMonth() + 1;

            if ( targetMonth > 11 ) {
                targetMonth = 0;
                targetYear++;
            }

            const lastDay = new Date( targetYear, targetMonth + 1, 0 ).getDate();
            nextRun = new Date( targetYear, targetMonth, lastDay, workflow.hour, workflow.minute, 0, 0 );

            if ( nextRun <= now ) {
                targetMonth++;
                if ( targetMonth > 11 ) {
                    targetMonth = 0;
                    targetYear++;
                }
                const nextLastDay = new Date( targetYear, targetMonth + 1, 0 ).getDate();
                nextRun = new Date( targetYear, targetMonth, nextLastDay, workflow.hour, workflow.minute, 0, 0 );
            }
        } else if ( cronRule ) {
            const interval = ( cronParser as any ).parseExpression( cronRule );
            nextRun = interval.next().toDate();
        } else {
            context.log( `❌ No se puede calcular la próxima ejecución: sin cronRule ni lastDayOfMonth.` );
            return;
        }

        // 8. Programar próximo mensaje en la cola de recurrencia
        const recurrenceSender = sbClient.createSender( ENVS.QUEUE.SCHEDULE_NAME );

        await recurrenceSender.scheduleMessages([{
            body: {
                workflowId,
                cronRule,
                sendEmailLogId: prepareResult.sendEmailLogId,
            },
            contentType: 'application/json',
        }], nextRun );

        await recurrenceSender.close();
        context.log( `📅 Próxima ejecución programada para: ${nextRun.toISOString()}` );

    } catch ( error: any ) {
        context.log( `❌ ERROR CRÍTICO en ScheduleHandler: ${error.message}` );
        throw error;
    } finally {
        await sbClient.close();
    }
}


// app.serviceBusQueue( ScheduleHandler.name, {
//     connection  : ENVS.QUEUE.CONNECTION,
//     queueName   : ENVS.QUEUE.SCHEDULE_NAME,
//     handler     : ScheduleHandler
// });

