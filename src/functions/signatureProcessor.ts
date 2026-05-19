import { format }         from "@formkit/tempo";

import { ENVS }           from "./envs";
import { PayloadStudent } from "./payloadEmail.model";

interface CompiledSignatureReplacer {
	regex    : RegExp;
	getValue : ( student: PayloadStudent, date: Date, formatStr?: string ) => string;
}

/**
 * Función robusta de formateo que previene caídas del worker debido a 
 * bugs internos de Tempo o a que el usuario introduzca cadenas de 
 * formato malformadas en la interfaz (ej. "YYYY YYYY" o repetidos).
 */
function safeFormat( date: Date, formatStr: string, defaultFormat: string ): string {
	// Adapta la sintaxis de corchetes [texto] a barras invertidas para compatibilidad nativa con Tempo
	const adaptedFormatStr = formatStr.replace( /\[(.*?)\]/g, ( _match: string, literal: string ): string => {
		return literal.replace( /[YMDdHhaAmsZ]/g, ( char: string ): string => "\\" + char );
	} );

	try {
		return format( {
			date   : date,
			format : adaptedFormatStr,
			tz     : "America/Santiago",
			locale : "es",
		} );
	} catch ( error ) {
		try {
			return format( {
				date   : date,
				format : defaultFormat,
				tz     : "America/Santiago",
				locale : "es",
			} );
		} catch ( fallbackError ) {
			// Si hasta el formato por defecto falla por algún motivo interno, 
			// evitamos el crash del worker y devolvemos la fecha en ISO.
			return date.toISOString();
		}
	}
}

/**
 * Compila las expresiones regulares de las firmas una sola vez al cargar el módulo.
 * Esto evita penalizaciones de rendimiento por crear objetos RegExp y recorrer
 * reemplazos en cada correo procesado por el Worker.
 */
function compileReplacers(): CompiledSignatureReplacer[] {
	const replacerDefs = [
		{
			placeholder : ENVS.SIGNATURE.STUDENT.NAME,
			getValue    : ( s: PayloadStudent ): string => {
				return s.name ?? "Estudiante";
			},
		},
		{
			placeholder : ENVS.SIGNATURE.STUDENT.EMAIL,
			getValue    : ( s: PayloadStudent ): string => {
				return s.email ?? "Correo";
			},
		},
		{
			placeholder : ENVS.SIGNATURE.DATE.DAY,
			getValue    : ( _s: PayloadStudent, d: Date, f?: string ): string => {
				return safeFormat( d, f ?? "D", "D" );
			},
		},
		{
			placeholder : ENVS.SIGNATURE.DATE.MONTH,
			getValue    : ( _s: PayloadStudent, d: Date, f?: string ): string => {
				return safeFormat( d, f ?? "M", "M" );
			},
		},
		{
			placeholder : ENVS.SIGNATURE.DATE.YEAR,
			getValue    : ( _s: PayloadStudent, d: Date, f?: string ): string => {
				return safeFormat( d, f ?? "YYYY", "YYYY" );
			},
		},
		{
			placeholder : ENVS.SIGNATURE.DATE.FULL,
			getValue    : ( _s: PayloadStudent, d: Date, f?: string ): string => {
				return safeFormat( d, f ?? "DD/MM/YYYY", "DD/MM/YYYY" );
			},
		},
	];

	return replacerDefs.map( ( def ): CompiledSignatureReplacer => {
		const tokenName = def.placeholder.replace( /[\{\}]/g, "" ).trim();
		const regex     = new RegExp( `\\{\\{\\s*${ tokenName }(?:\\s*:\\s*([^}]+))?\\s*\\}\\}`, "g" );

		return {
			regex    : regex,
			getValue : def.getValue,
		};
	} );
}

// Caché global de expresiones regulares en memoria (se ejecuta 1 vez).
const COMPILED_REPLACERS = compileReplacers();

/**
 * Procesa y reemplaza todas las firmas/placeholders dentro del contenido HTML de un correo.
 * Versión extremadamente optimizada para alto rendimiento.
 *
 * @param html - El HTML original del template.
 * @param student - Los datos del estudiante destinatario.
 * @returns El HTML con todas las firmas procesadas y reemplazadas.
 */
export function processSignatures( html: string, student: PayloadStudent ): string {
	// 1. EARLY EXIT: Si no hay firmas en el HTML, retornamos de inmediato. O(n) rapidísimo.
	if ( !html.includes( "{{" ) ) {
		return html;
	}

	let finalHtml = html;
	const now     = new Date();

	// 2. Usar los Regex pre-compilados en memoria.
	for ( const replacer of COMPILED_REPLACERS ) {
		finalHtml = finalHtml.replace( replacer.regex, ( _match: string, formatStr?: string ): string => {
			const trimmedFormat = formatStr ? formatStr.trim() : undefined;
			return replacer.getValue( student, now, trimmedFormat );
		} );
	}

	return finalHtml;
}
