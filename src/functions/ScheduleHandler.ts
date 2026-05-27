import { app, InvocationContext }               from "@azure/functions";
import { ServiceBusClient, ServiceBusSender }   from "@azure/service-bus";

import * as cronParser from 'cron-parser';

import {
    PayloadRecurrent,
    Workflow,
    PrepareExecutionResponse
}                                           from "./payloadEmail.model";
import { ENVS }                             from "./envs";
import apiRequest, { isApiError, METHOD }   from "./fetch.service";

// Reutilización de conexión a Service Bus (Mejor práctica para evitar overhead AMQP)
const sbClient: ServiceBusClient = new ServiceBusClient( ENVS.SERVICE_BUS_CONNECTION );


export async function ScheduleHandler(
    message: PayloadRecurrent,
    context: InvocationContext
): Promise<void> {
    const { workflowId, cronRule, sendEmailLogId } = message;

    context.log( `⏰ Iniciando proceso para Workflow ID: ${ workflowId } | SendEmailLog: ${ sendEmailLogId }` );

    try {
        const backendUrl        = ENVS.MAIL_STUDIO.BACKEND_URL;
        const workflowEndpoint  = ENVS.MAIL_STUDIO.WORKFLOW_ENDPOINT;
        const workflowUrl       = `${ backendUrl }/${workflowEndpoint}/${ workflowId }`;

        // Notificar estado PROCESSING al backend de forma asíncrona (fire-and-forget)
        apiRequest({
            endpoint : `${ backendUrl }/send-email-logs/${ sendEmailLogId }/status`,
            method   : METHOD.PATCH,
            body     : {
                status : "PROCESSING",
            },
        }).catch( ( err: any ) => {
            context.log( `⚠️ No se pudo actualizar estado a PROCESSING: ${ err.message }` );
        });

        // 1. Obtener datos completos del Workflow
        context.log( `🔗 Solicitando datos al backend: ${ workflowUrl }` );

        let workflow: Workflow;

        try {
            const response = await apiRequest<Workflow>({
                endpoint : workflowUrl,
            });

            if ( isApiError( response )) {
                throw new Error( response.message );
            }

            workflow = response;
        } catch ( error: any ) {
            throw new Error( `Workflow no encontrado o error de API: ${ error.message }` );
        }

        // 2. Verificar que el workflow siga activo
        if ( !workflow.active ) {
            context.log( `🛑 Workflow ${ workflowId } desactivado por el admin. Terminando ciclo.` );

            return;
        }

        const { students, template, templateFileId, subject, cc, bcc } = workflow;

        if ( !students || !Array.isArray( students )) {
            throw new Error( "El backend no devolvió una lista de estudiantes válida." );
        }

        // 3. Encolar emails individuales en la cola principal (solo si hay alumnos)
        if ( students.length > 0 ) {
            const emailSender: ServiceBusSender = sbClient.createSender( ENVS.QUEUE.NAME );
            let batch                           = await emailSender.createMessageBatch();

            context.log( `📦 Encolando ${ students.length } mensajes en ${ ENVS.QUEUE.NAME }...` );

            for ( let i = 0; i < students.length; i++ ) {
                const emailPayload = {
                    body        : {
                        student        : students[ i ],
                        templateId     : template?.id,
                        templateFileId : templateFileId,
                        subject        : subject,
                        notificationId : sendEmailLogId,
                        cc             : cc,
                        bcc            : bcc,
                    },
                    contentType : 'application/json'
                };

                if ( !batch.tryAddMessage( emailPayload ) ) {
                    await emailSender.sendMessages( batch );

                    batch = await emailSender.createMessageBatch();

                    if ( !batch.tryAddMessage( emailPayload ) ) {
                        context.log( `⚠️ Saltando correo en índice ${ i }: El mensaje excede el límite de tamaño.` );
                        continue;
                    }
                }
            }

            if ( batch.count > 0 ) {
                await emailSender.sendMessages( batch );
            }

            await emailSender.close();
            context.log( `✅ Encolamiento masivo completado exitosamente.` );
        } else {
            context.log( `⚠️ Sin estudiantes asociados a este workflow en esta ejecución.` );
        }

        // Notificar estado COMPLETED al backend de forma asíncrona (fire-and-forget)
        apiRequest( {
            endpoint : `${ backendUrl }/send-email-logs/${ sendEmailLogId }/status`,
            method   : METHOD.PATCH,
            body     : {
                status : "COMPLETED",
            },
        }).catch( ( err: any ) => {
            context.log( `⚠️ No se pudo actualizar estado a COMPLETED: ${ err.message }` );
        });

        // 4. Determinar si debe re-programarse
        const isOnce: boolean = workflow.frequency === 'ONCE';

        if ( isOnce ) {
            context.log( `📌 Workflow ONCE completado. No se re-programa.` );
            return;
        }

        // 5. Pedir al backend que prepare la próxima ejecución (crea nuevo SendEmailLog + verifica límites)
        context.log( `🔄 Solicitando preparación de próxima ejecución...` );

        let prepareResult: PrepareExecutionResponse;

        try {
            const response = await apiRequest<PrepareExecutionResponse>( {
                endpoint : `${ backendUrl }/workflow/${ workflowId }/prepare-execution`,
                method   : METHOD.POST,
            } );

            if ( isApiError( response ) ) {
                throw new Error( response.message );
            }

            prepareResult = response;
        } catch ( error: any ) {
            throw new Error( `Error al preparar próxima ejecución: ${ error.message }` );
        }

        if ( prepareResult.shouldStop ) {
            context.log( `🛑 Recurrencia finalizada: ${ prepareResult.reason }` );
            return;
        }

        // 6. Calcular próxima fecha de ejecución
        let nextRun: Date;

        if ( workflow.lastDayOfMonth ) {
            // Cálculo dinámico corregido para el último día del mes
            const now: Date         = new Date();
            let targetYear: number  = now.getFullYear();
            let targetMonth: number = now.getMonth(); // Inicia en el mes actual para no saltárselo

            const lastDay: number = new Date( targetYear, targetMonth + 1, 0 ).getDate();
            nextRun = new Date( targetYear, targetMonth, lastDay, workflow.hour, workflow.minute, 0, 0 );

            // Si la fecha ya pasó en el mes actual, avanzamos al siguiente mes
            if ( nextRun <= now ) {
                targetMonth++;
                if ( targetMonth > 11 ) {
                    targetMonth = 0;
                    targetYear++;
                }
                const nextLastDay: number = new Date( targetYear, targetMonth + 1, 0 ).getDate();
                nextRun = new Date( targetYear, targetMonth, nextLastDay, workflow.hour, workflow.minute, 0, 0 );
            }
        } else if ( cronRule ) {
            const interval: any = ( cronParser as any ).parseExpression( cronRule );
            nextRun             = interval.next().toDate();
        } else {
            context.log( `❌ No se puede calcular la próxima ejecución: sin cronRule ni lastDayOfMonth.` );
            return;
        }

        // 7. Programar próximo mensaje en la cola de recurrencia
        const recurrenceSender: ServiceBusSender = sbClient.createSender( ENVS.QUEUE.SCHEDULE_NAME );

        await recurrenceSender.scheduleMessages( [ {
            body        : {
                workflowId     : workflowId,
                cronRule       : cronRule,
                sendEmailLogId : prepareResult.sendEmailLogId,
            },
            contentType : 'application/json',
        } ], nextRun );

        await recurrenceSender.close();
        context.log( `📅 Próxima ejecución programada para: ${ nextRun.toISOString() }` );
    } catch ( error: any ) {
        context.log( `❌ ERROR CRÍTICO en ScheduleHandler: ${ error.message }` );

        // Notificar estado FAILED al backend de forma asíncrona (fire-and-forget)
        apiRequest( {
            endpoint : `${ ENVS.MAIL_STUDIO.BACKEND_URL }/send-email-logs/${ sendEmailLogId }/status`,
            method   : METHOD.PATCH,
            body     : {
                status  : "FAILED",
                message : error.message,
            },
        }).catch( ( err: any ) => {
            context.log( `⚠️ No se pudo actualizar estado a FAILED: ${ err.message }` );
        });

        throw error;
    }
}


app.serviceBusQueue( ScheduleHandler.name, {
    connection : ENVS.QUEUE.CONNECTION,
    queueName  : ENVS.QUEUE.SCHEDULE_NAME,
    handler    : ScheduleHandler
} );
