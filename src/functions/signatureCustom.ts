import { PayloadStudent } from "./payloadEmail.model";

/**
 * Procesa y reemplaza todas las firmas customizadas dinámicas delimitadas por [[KEY]].
 * Busca las claves en student.customData de manera insensible a mayúsculas/minúsculas.
 *
 * @param html - El contenido HTML original.
 * @param student - Los datos del estudiante conteniendo customData.
 * @returns El HTML con los reemplazos aplicados.
 */
export function processCustomSignatures( html: string, student: PayloadStudent ): string {
	// 1. EARLY EXIT: Si no hay marcas de corchetes dobles o si customData no existe, salimos de inmediato.
	if ( !html.includes( "[[" ) || !student.customData ) {
		return html;
	}

	let finalHtml = html;

	// 2. Buscamos todas las marcas [[KEY]] usando RegExp
	const regex = /\[\[\s*([^\]]+)\s*\]\]/gi;

	finalHtml = finalHtml.replace( regex, ( _match: string, key: string ): string => {
		const lowerKey = key.trim().toLowerCase();

		// Búsqueda insensible a mayúsculas/minúsculas en las llaves del customData
		const matchedKey = Object.keys( student.customData! ).find( ( k: string ): boolean => {
			return k.toLowerCase() === lowerKey;
		} );

		if ( matchedKey ) {
			return student.customData![ matchedKey ] ?? "";
		}

		// Si no viene en customData, lo dejamos vacío ""
		return "";
	} );

	return finalHtml;
}
