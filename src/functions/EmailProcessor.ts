import { app, InvocationContext } from "@azure/functions";

import { Resend }   from 'resend';
import { LRUCache } from 'lru-cache';

import { ENVS }                     from "./envs";
import { PayloadEmail, Priority }   from "./payloadEmail.model";
import apiRequest, { isApiError }   from "./fetch.service";

// Configuración fuera del handler
const options = {
  max: 100, // Máximo de templates en memoria
  ttl: 1000 * 60 * 60, // Vida máxima de 1 hora (por si se edita el template)
};

export const templateCache = new LRUCache<string, string>( options );

const resend = new Resend( ENVS.RESEND_API_KEY );


export async function EmailProcessor(
    message: PayloadEmail,
    context: InvocationContext
): Promise<void> {
    context.log(`Procesando mensaje para la cola: ${JSON.stringify( message )}`);

    const {
        student,
        templateId,
        subject,
        cc,
        bcc,
        notificationId,
        priority = Priority.NORMAL,
    } = message;

    // 1. Intentar obtener de caché
    let template = templateCache.get( templateId );

    if ( !template ) {
        context.log( `Cache miss para template ${templateId}. Buscando en API...` );

        const response = await apiRequest<string>({
            endpoint: `${ENVS.MAIL_STUDIO.BACKEND_URL}/${ENVS.MAIL_STUDIO.TEMPLATE_ENDPOINT}/${templateId}`,
        });

        if ( isApiError( response )) {
            context.log( 'Error obteniendo template:', response.message );
            throw new Error( "Template no encontrado" );
        }

        template = response;

        templateCache.set( templateId, template );
    }

    let finalHtml = template;

    if ( finalHtml.includes( ENVS.SIGNATURE_STUDENT_NAME! )) {
        if ( !student.name ) {
            context.log(`Warn: Alumno ${student.email} sin nombre completo para firma.`);
        }

        finalHtml = finalHtml.replace( ENVS.SIGNATURE_STUDENT_NAME!, student.name ?? 'Estudiante' );
    }

    try {
        const { data: _data, error } = await resend.emails.send({
            from    : ENVS.MAIL_STUDIO.FROM,
            to      : student.email,
            cc,
            bcc,
            html: finalHtml,
            subject,
            headers: {
                "X-Auto-Response-Suppress"  : "All",
                "Auto-Submitted"            : "auto-generated",
                "X-Entity-Ref-Type"         : "transactional",
                ...( ENVS.ABUSE_TO ? { "X-Report-Abuse-To": ENVS.ABUSE_TO } : {} )
            },
            tags: [
                { name: "category",         value: "system_notification" },
                { name: "notification_id",  value: notificationId },
                { name: "priority",         value: priority },
                { name: "message_type",     value: "informational" }
            ]
        });

        if ( error ) {
            context.log( '*********Resend API Error:', JSON.stringify( error ));
            throw new Error( `Resend falló: ${error.message}` );
        }

        context.log( 'Correo enviado exitosamente vía Resend' );
    } catch ( error ) {
        context.log( 'Error enviando correo:', error );

        throw error;
    }
}

app.serviceBusQueue( EmailProcessor.name, {
    connection  : ENVS.QUEUE.CONNECTION,
    queueName   : ENVS.QUEUE.NAME,
    handler     : EmailProcessor
});
