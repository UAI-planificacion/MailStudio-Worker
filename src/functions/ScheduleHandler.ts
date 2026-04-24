import { app, InvocationContext } from "@azure/functions";
import { ServiceBusClient, ServiceBusMessage } from "@azure/service-bus";

import * as cronParser from 'cron-parser';

import { ENVS }                         from "./envs";
import { PayloadRecurrent, Workflow }   from "./payloadEmail.model";
import apiRequest, { isApiError }       from "./fetch.service";
import { templateCache }                from "./EmailProcessor";


export async function ScheduleHandler(
    message: PayloadRecurrent,
    context: InvocationContext
): Promise<void> {
    const { workflowId, cronRule } = message;

    context.log( `⏰ Iniciando proceso de recurrencia para Workflow ID: ${workflowId}` );

    const sbClient = new ServiceBusClient( ENVS.SERVICE_BUS_CONNECTION );

    try {
        const backendUrl = ENVS.MAIL_STUDIO.BACKEND_URL;

        context.log( `🔗 Solicitando datos al backend: ${backendUrl}/workflow/${workflowId}` );

        const workflow = await apiRequest<Workflow>({
            endpoint : `${backendUrl}/workflow/${workflowId}`,
        });

        if ( workflow.status === 'INACTIVE' ) { 
            context.log( `🛑 Workflow ${workflowId} desactivado por el admin. Terminando ciclo.` );
            return;
        }

        if ( isApiError( workflow )) {
            throw new Error( "Workflow no encontrado" );
        }

        const { students, template, subject, notificationId, cc, bcc } = workflow;

        if ( !students || !Array.isArray( students ) ) {
            throw new Error( "El backend no devolvió una lista de estudiantes válida." );
        }

        templateCache.set( template.id, template.content );

        const emailSender = sbClient.createSender( ENVS.QUEUE.NAME );

        let batch = await emailSender.createMessageBatch();

        context.log( `📦 Encolando ${students.length} mensajes en queue.1...` );

        for ( let i = 0; i < students.length; i++ ) {
            const emailPayload = {
                body        : { 
                    student        : students[ i ], 
                    templateId     : template.id, 
                    subject,
                    notificationId,
                    cc,
                    bcc,
                },
                contentType : 'application/json'
            };

            if ( !batch.tryAddMessage( emailPayload ) ) {
                await emailSender.sendMessages( batch );

                batch = await emailSender.createMessageBatch();

                if ( !batch.tryAddMessage( emailPayload ) ) {
                    context.log( `⚠️ Saltando correo en índice ${i}: El mensaje excede el límite de tamaño.` );
                    continue;
                }
            }

            // if ( i % 5000 === 0 && i > 0 ) {
            //     context.log( `⏳ Progreso: ${i} mensajes encolados...` );
            // }
        }

        await emailSender.sendMessages( batch );
        await emailSender.close();
        context.log( `✅ Encolamiento masivo completado exitosamente.` );

        const interval = ( cronParser as any ).parseExpression( cronRule );
        const nextRun = interval.next().toDate();

        const recurrenceSender = sbClient.createSender( ENVS.QUEUE.SCHEDULE_NAME );

        await recurrenceSender.scheduleMessages([{
            body : { workflowId, cronRule }
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

// Registro de la función en Azure
// app.serviceBusQueue( ScheduleHandler.name, {
//     connection  : ENVS.QUEUE.CONNECTION,
//     queueName   : ENVS.QUEUE.SCHEDULE_NAME,
//     handler     : ScheduleHandler
// });
