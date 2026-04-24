const envs = process.env;

// Lista de variables requeridas
const requiredEnvs = [
    'ServiceBusConnection',
    'RESEND_API_KEY',
    'QUEUE_CONNECTION',
    'QUEUE_NAME',
    'QUEUE_SCHEDULE_NAME',
    'MAIL_STUDIO_FROM',
    'MAIL_STUDIO_BACKEND_URL',
    'MAIL_STUDIO_TEMPLATE_ENDPOINT',
    'SIGNATURE_STUDENT_NAME',
    'ABUSE_TO'
];

// Validar que todas existan
for ( const envName of requiredEnvs ) {
    if ( !envs[ envName ]) {
        throw new Error( `Falta la variable de entorno: ${envName}. El Worker no puede iniciar.` );
    }
}

export const ENVS = {
    SERVICE_BUS_CONNECTION : envs.ServiceBusConnection!,
    RESEND_API_KEY           : envs.RESEND_API_KEY!,
    QUEUE                    : {
        CONNECTION           : envs.QUEUE_CONNECTION!,
        NAME                 : envs.QUEUE_NAME!,
        SCHEDULE_NAME        : envs.QUEUE_SCHEDULE_NAME!,
    },
    MAIL_STUDIO : {
        BACKEND_URL         : envs.MAIL_STUDIO_BACKEND_URL!,
        TEMPLATE_ENDPOINT   : envs.MAIL_STUDIO_TEMPLATE_ENDPOINT!,
        FROM                : envs.MAIL_STUDIO_FROM!,

    },
    SIGNATURE_STUDENT_NAME  : envs.SIGNATURE_STUDENT_NAME!,
    ABUSE_TO                : envs.ABUSE_TO!,
}
