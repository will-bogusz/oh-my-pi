/** Native archive selected by the shared standalone-binary build. */
export interface EmbeddedCuaArchive {
	filePath: string;
	sha256: string;
	platform: string;
	revision: string;
	/** Every archive member, including artifact.json and license notices. */
	files: Record<string, string>;
}

/** Source runs use an explicit installed artifact; compiled builds replace this module. */
export const embeddedCuaArchive: EmbeddedCuaArchive | null = null;
