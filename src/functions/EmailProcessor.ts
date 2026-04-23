import {
    app,
    InvocationContext
}                   from "@azure/functions";
import { Resend }   from 'resend';

import { PayloadEmail } from "./payloadEmail.model";


const resend = new Resend( process.env.RESEND_API_KEY );


export async function EmailProcessor(
    message: PayloadEmail,
    context: InvocationContext
): Promise<void> {
    context.log(`Procesando mensaje para la cola: ${JSON.stringify(message)}`);

    const { email, template, subject } = message;
    context.log('🚀 **********~ EmailProcessor ~ subject:', subject)

    try {
        await resend.emails.send({
            from    : process.env.RESEND_FROM,
            to      : email,
            subject,
            html    : template
        });

        context.log( 'Correo enviado exitosamente vía Resend' );
    } catch (error) {
        context.log( 'Error enviando correo:', error );

        throw error; // Esto hace que Service Bus reintente si falla
    }
}

app.serviceBusQueue( 'EmailProcessor', {
    connection  : 'ServiceBusConnection',
    queueName   : 'queue.1',
    handler     : EmailProcessor
});
