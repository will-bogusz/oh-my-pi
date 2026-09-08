import type { CuaComputerSession } from "../../src/tools/computer/cua-session";
import type { NativeComputerSession } from "../../src/tools/computer/native-session";
import type { ComputerBackend, ComputerBackendFactory } from "../../src/tools/computer/worker";

type Assert<T extends true> = T;

// Both implementations must satisfy the same interpreter contract without
// inheriting concrete backend fields. These are compiler checks, never imports
// that initialize either native implementation at runtime.
export type CuaImplementsComputer = Assert<CuaComputerSession extends ComputerBackend ? true : false>;
export type NativeImplementsComputer = Assert<NativeComputerSession extends ComputerBackend ? true : false>;
export type CuaFactoryMatches = Assert<typeof CuaComputerSession.create extends ComputerBackendFactory ? true : false>;
export type NativeFactoryMatches = Assert<
	typeof NativeComputerSession.create extends ComputerBackendFactory ? true : false
>;
export type DrainIsRequired = Assert<Omit<ComputerBackend, "drain"> extends ComputerBackend ? false : true>;
export type DriverInternalsAreNotRequired = Assert<
	Extract<keyof ComputerBackend, "metadata" | "permissions"> extends never ? true : false
>;
