# MailStudio Worker

Worker de Azure Functions escrito en TypeScript para el procesamiento y envío masivo y programado de correos electrónicos utilizando Resend como proveedor de mensajería.

## Características Principales

- **Procesamiento de Emails en Cola**: Procesamiento asíncrono y en paralelo mediante Azure Service Bus.
- **Plantillas Dinámicas con Caché**: Consulta de plantillas al backend de MailStudio con almacenamiento en caché local utilizando [ LRUCache ]( https://www.npmjs.com/package/lru-cache ) ( capacidad máxima de 100 plantillas y TTL de 1 hora ) para optimizar el rendimiento y disminuir latencias.
- **Procesamiento de Firmas y Fechas**:
  - Reemplazo de placeholders estándar como `{{ StudentName }}` y `{{ StudentEmail }}`.
  - Formateo avanzado de fechas en español ( localización `"es"`, zona horaria `"America/Santiago"` ) mediante la librería [ @formkit/tempo ]( https://tempo.formkit.com/ ).
  - Reemplazo dinámico de firmas personalizadas mediante el formato `[ [ KEY ] ]`, cruzando información insensible a mayúsculas/minúsculas con el objeto `student.customData`.
- **Mapeo y Encolamiento Recurrente**:
  - Un gestor de calendarios y recurrencias ( `ScheduleHandler` ) que obtiene workflows de envío desde el backend.
  - Soporte de expresiones Cron y cálculo dinámico del último día del mes.
  - Reprogramación automática encolando mensajes futuros programados en Service Bus.
- **Políticas Anti-Spam y Transaccionales**: Configuración de cabeceras de cabecera como `X-Auto-Response-Suppress` y tags de clasificación en Resend.

---

## Arquitectura y Funciones

El proyecto cuenta con dos funciones principales configuradas bajo el modelo de programación v4 de Azure Functions:

### 1. [ EmailProcessor ]( file:///d:/GitHub/MailStudio-Worker/src/functions/EmailProcessor.ts )
Escucha en la cola principal configurada en la variable de entorno `QUEUE_NAME` ( por defecto `mailstudio-emails` ).
- **Entrada**: Mensajes en cola que corresponden al tipo [ PayloadEmail ]( file:///d:/GitHub/MailStudio-Worker/src/functions/payloadEmail.model.ts ).
- **Proceso**:
  - Obtiene el HTML de la plantilla ( vía caché en memoria o consultando al API de MailStudio ).
  - Procesa las firmas estándar y personalizadas.
  - Envía el email a través de la API de Resend con las cabeceras requeridas.

### 2. [ ScheduleHandler ]( file:///d:/GitHub/MailStudio-Worker/src/functions/ScheduleHandler.ts )
Escucha en la cola de recurrencias configurada en la variable de entorno `QUEUE_SCHEDULE_NAME` ( por defecto `recurrent-queue` ).
- **Entrada**: Mensajes en cola del tipo [ PayloadRecurrent ]( file:///d:/GitHub/MailStudio-Worker/src/functions/payloadEmail.model.ts ).
- **Proceso**:
  - Actualiza el estado del log de envío a `PROCESSING` en el backend.
  - Obtiene los datos del Workflow desde el backend.
  - Encola de forma masiva los correos individuales de los estudiantes en la cola principal ( `QUEUE_NAME` ) utilizando lotes ( batches ) de Service Bus.
  - Actualiza el estado a `COMPLETED`.
  - Si la frecuencia no es de tipo `ONCE`, solicita al backend preparar la siguiente ejecución y calcula la próxima fecha de envío.
  - Programa el siguiente mensaje en la cola utilizando la funcionalidad de mensajes diferidos de Service Bus.

---

## Configuración del Entorno Local

### Requisitos Previos

1. **Node.js**: Se recomienda utilizar la versión 18 ( compatible con versiones superiores ).
2. **Administrador de Paquetes**: Es obligatorio utilizar **pnpm** para instalar librerías y dependencias.
3. **Azure Functions Core Tools**: Versión 4.x para ejecutar las funciones de forma local.
4. **Docker**: Utilizado para levantar el emulador local de Azure Service Bus.

### Variables de Entorno

Crea un archivo [ local.settings.json ]( file:///d:/GitHub/MailStudio-Worker/local.settings.json ) en la raíz del proyecto. Las claves y valores deben estar formateados y alineados de la siguiente manera:

```json
{
	"IsEncrypted" : false,
	"Values"      : {
		"FUNCTIONS_WORKER_RUNTIME"      : "node",
		"AzureWebJobsStorage"           : "UseDevelopmentStorage=true",
		"ServiceBusConnection"          : "Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SDK_LOCAL_KEY;UseDevelopmentEmulator=true;",
		"RESEND_API_KEY"                : "re_tu_api_key_aqui",
		"MAIL_STUDIO_FROM"              : "MailStudio <onboarding@resend.dev>",
		"QUEUE_NAME"                    : "mailstudio-emails",
		"QUEUE_SCHEDULE_NAME"           : "recurrent-queue",
		"QUEUE_CONNECTION"              : "ServiceBusConnection",
		"MAIL_STUDIO_BACKEND_URL"       : "http://localhost:5050/api/v1",
		"MAIL_STUDIO_TEMPLATE_ENDPOINT" : "templates/generated",
		"MAIL_STUDIO_WORKFLOW_ENDPOINT" : "workflow",
		"SIGNATURE_STUDENT_NAME"        : "{{StudentName}}",
		"SIGNATURE_STUDENT_EMAIL"       : "{{StudentEmail}}",
		"SIGNATURE_DATE_DAY"            : "{{Day}}",
		"SIGNATURE_DATE_MONTH"          : "{{Month}}",
		"SIGNATURE_DATE_YEAR"           : "{{Year}}",
		"SIGNATURE_DATE_FULL"           : "{{FullDate}}",
		"ABUSE_TO"                      : "abuse@tudominio.com"
	}
}
```

*Nota: Asegúrate de alinear verticalmente las claves utilizando tabs y dos puntos alineados.*

---

## Desarrollo e Instalación

### 1. Instalar Dependencias
Siempre utiliza `pnpm` para la instalación de dependencias:
```bash
pnpm install
```

### 2. Compilar el Proyecto
Puedes compilar el proyecto una sola vez o dejarlo en modo de escucha para cambios:
```bash
# Compilación única
pnpm build

# Modo de escucha activa
pnpm watch
```

### 3. Iniciar el Worker Localmente
Asegúrate de tener corriendo tu contenedor Docker con el emulador de Service Bus y ejecuta:
```bash
pnpm start
```

---

## Formato y Procesamiento de Firmas

### 1. Placeholders Estándar ( Tempo )
Se puede formatear dinámicamente el día, mes, año y fecha completa agregando un formato específico después de dos puntos. Ejemplos de uso en plantillas HTML:
- `{{StudentName}}`: Reemplaza por el nombre del estudiante ( por defecto "Estudiante" ).
- `{{Day}}`: Día actual ( formato por defecto `D` ).
- `{{Day:DD}}`: Día actual formateado a dos dígitos.
- `{{Month:MMMM}}`: Nombre completo del mes actual ( ej. "junio" ).
- `{{Year:YYYY}}`: Año actual con 4 dígitos.
- `{{FullDate:DD/MM/YYYY}}`: Fecha completa formateada ( ej. "3/6/2026" ).

### 2. Firmas Dinámicas Personalizadas
Cualquier clave delimitada por doble corchete `[ [ KEY ] ]` será buscada dentro del diccionario `customData` provisto en el objeto del estudiante. Si la clave no se encuentra, se reemplazará por un string vacío.

---

## Despliegue en Azure

Para desplegar el Worker en Azure, se deben seguir los siguientes pasos:

1. **Creación de Colas**: Asegúrate de que las colas definidas en las variables `QUEUE_NAME` y `QUEUE_SCHEDULE_NAME` estén creadas manualmente en tu recurso de Azure Service Bus.
2. **Publicar la Aplicación**:
   Puedes publicar utilizando Azure Functions Core Tools desde la terminal:
   ```bash
   func azure functionapp publish <NOMBRE_DE_TU_FUNCTION_APP>
   ```
   O configurar un flujo de integración continua mediante **GitHub Actions** utilizando la plantilla de Azure Functions para Node.js.
