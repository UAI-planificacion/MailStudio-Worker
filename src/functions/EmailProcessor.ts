import { app, InvocationContext } from "@azure/functions";

import { Resend }   from 'resend';
import { LRUCache } from 'lru-cache';

import { ENVS }                     from "./envs";
import { PayloadEmail, Priority }   from "./payloadEmail.model";
import apiRequest, { isApiError }   from "./fetch.service";
import { processSignatures }        from "./signatureProcessor";
import { processCustomSignatures }  from "./signatureCustom";


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
    context.log( `Procesando mensaje para la cola: ${JSON.stringify( message )}` );

    const {
        student,
        templateId,
        templateFileId,
        subject,
        cc,
        bcc,
        notificationId,
        priority = Priority.NORMAL,
    } = message;

    if ( !templateId && !templateFileId ) {
        throw new Error( "Debe enviar templateId o templateFileId" );
    }

    if ( templateId && templateFileId ) {
        throw new Error( "Debe enviar templateId o templateFileId, no ambos" );
    }

    // 1. Intentar obtener de caché
    let template = templateCache.get( templateId || templateFileId );

    const templateType = templateId ? 'template' : 'file';
    const templateForUse = templateId || templateFileId;

    if ( !template ) {
        context.log( `Cache miss para template ${templateType}: ${templateForUse}. Buscando en API...` );

        const response = await apiRequest<string>({
            endpoint: `${ENVS.MAIL_STUDIO.BACKEND_URL}/${ENVS.MAIL_STUDIO.TEMPLATE_ENDPOINT}/${templateForUse}?type=${templateType}`,
        });

        if ( isApiError( response )) {
            context.log( 'Error obteniendo template:', response.message );
            throw new Error( "Template no encontrado" );
        }

        template = response;

        templateCache.set( templateForUse, template );
    }

	let finalHtml = template;

	if ( !student.name ) {
		context.log( `Warn: Alumno ${ student.email } sin nombre completo para firma.` );
	}

	finalHtml = processSignatures( finalHtml, student );
	finalHtml = processCustomSignatures( finalHtml, student );

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
