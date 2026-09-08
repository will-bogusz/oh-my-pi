import { CuaComputerSession } from "./cua-session";
import { NativeComputerSession } from "./native-session";
import type { ComputerBackend } from "./worker";

/** Platform selection is explicit; a failed driver never triggers another input route. */
export function createComputerBackend(options: { display?: string }): Promise<ComputerBackend> {
	if (process.platform === "darwin" && process.arch === "arm64") return CuaComputerSession.create(options);
	return NativeComputerSession.create(options);
}
