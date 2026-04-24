import { app, InvocationContext } from "@azure/functions";
import { ServiceBusClient, ServiceBusMessage } from "@azure/service-bus";
import * as cronParser from 'cron-parser';

import { PayloadRecurrent, Workflow } from "./payloadEmail.model";
import apiRequest, { isApiError } from "./fetch.service";
import { ENVS } from "./envs";
import { templateCache } from "./EmailProcessor";

/**
 * Esta función se encarga de:
 * 1. Despertar según la fecha programada en 'recurrent-queue'.
 * 2. Pedir la lista de correos y el template a tu Backend (NestJS).
 * 3. Encolar masivamente los correos en 'queue.1' para que el EmailProcessor los envíe.
 * 4. Calcular y programar la siguiente ejecución basada en la regla Cron.
 */
export async function ScheduleHandler(
    message: PayloadRecurrent,
    context: InvocationContext
): Promise<void> {
    const { workflowId, cronRule } = message;

    context.log( `⏰ Iniciando proceso de recurrencia para Workflow ID: ${workflowId}` );

    // Cliente de Service Bus (usa la conexión de tu local.settings.json)
    const sbClient = new ServiceBusClient( ENVS.SERVICE_BUS_CONNECTION );

    try {
        // --- PASO 1: OBTENER DATOS DESDE EL BACKEND ---
        const backendUrl = ENVS.MAIL_STUDIO.BACKEND_URL;

        context.log( `🔗 Solicitando datos al backend: ${backendUrl}/workflow/${workflowId}` );

        const workflow = await apiRequest<Workflow>({
            endpoint : `${backendUrl}/workflow/${workflowId}`,
        });

        if ( workflow.status === 'INACTIVE' ) { 
            context.log( `🛑 Workflow ${workflowId} desactivado por el admin. Terminando ciclo.` );
            return; // Aquí muere el "Efecto Dominó"
        }

        if ( isApiError( workflow )) {
            throw new Error( "Workflow no encontrado" );
        }

        const { students, template, subject, notificationId, cc, bcc } = workflow;

        if ( !students || !Array.isArray( students ) ) {
            throw new Error( "El backend no devolvió una lista de estudiantes válida." );
        }

        // Guardamos el template en caché para el EmailProcessor
        templateCache.set( template.id, template.content );

        // --- PASO 2: ENCOLAMIENTO MASIVO EN QUEUE.1 ---
        // Aquí "llamamos" al EmailProcessor metiendo mensajes en su cola
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

            // Intentar añadir al lote actual
            if ( !batch.tryAddMessage( emailPayload ) ) {
                // Si el lote está lleno, lo enviamos y creamos uno nuevo
                await emailSender.sendMessages( batch );

                batch = await emailSender.createMessageBatch();

                if ( !batch.tryAddMessage( emailPayload ) ) {
                    context.log( `⚠️ Saltando correo en índice ${i}: El mensaje excede el límite de tamaño.` );
                    // Continuamos con el siguiente para no detener el workdflow entero
                    continue;
                }
            }

            // Log de progreso cada 5000 correos para no saturar
            // if ( i % 5000 === 0 && i > 0 ) {
            //     context.log( `⏳ Progreso: ${i} mensajes encolados...` );
            // }
        }

        // Enviar el último lote restante
        await emailSender.sendMessages( batch );
        await emailSender.close();
        context.log( `✅ Encolamiento masivo completado exitosamente.` );

        // --- PASO 3: AUTOREPROGRAMACIÓN ---
        // Calculamos la siguiente fecha usando cron-parser
        const interval = ( cronParser as any ).parseExpression( cronRule );
        const nextRun = interval.next().toDate();

        const recurrenceSender = sbClient.createSender( 'schedule-queue' );

        // Programamos el "ticket" para el futuro en la misma cola que escucha esta función
        await recurrenceSender.scheduleMessages([{
            body : { workflowId, cronRule }
        }], nextRun );

        await recurrenceSender.close();
        context.log( `📅 Próxima ejecución programada para: ${nextRun.toISOString()}` );

    } catch ( error: any ) {
        context.log( `❌ ERROR CRÍTICO en ScheduleHandler: ${error.message}` );
        // Re-lanzamos el error para que Service Bus sepa que falló (hará reintentos según config)
        throw error;
    } finally {
        // Cerramos el cliente principal al terminar
        await sbClient.close();
    }
}

// Registro de la función en Azure
// app.serviceBusQueue( ScheduleHandler.name, {
//     connection  : ENVS.QUEUE.CONNECTION,
//     queueName   : ENVS.QUEUE.SCHEDULE_NAME,
//     handler     : ScheduleHandler
// });
