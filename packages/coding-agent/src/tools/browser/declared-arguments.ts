/**
 * Object arguments to browser verbs are checked against `declarations.d.ts`,
 * the typed API the model reads (`browser.help()`): a key the declarations do
 * not name is refused, and the refusal lists the keys they do. The
 * declarations are the only list — declaring an option is what makes it
 * accepted, so what the model is told and what a call accepts cannot drift.
 */
import type * as BabelParser from "@babel/parser";
import type * as t from "@babel/types";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
// @ts-expect-error Bun imports this declaration source as text instead of a TypeScript module.
import declarationsSource from "./declarations.d.ts" with { type: "text" };

/** The declared APIs whose calls are checked, as each reads in a refusal. */
const API_LABELS = {
	browser: "browser",
	BrowserTab: "tab",
	BrowserTabRealm: "tab",
	BrowserElement: "element",
	BrowserFrame: "frame",
} as const;

export type DeclaredApi = keyof typeof API_LABELS;

/** A declared object type: each key it names, and that key's own object type when it has one. */
type Shape = ReadonlyMap<string, Shape | undefined>;

interface DeclaredMethod {
	/** Positional parameters: the declared name and, for an object type, its keys. */
	parameters: { name: string; shape?: Shape }[];
	/** The declared API the method resolves to (`tab.ref()` → `BrowserElement`). */
	returns?: DeclaredApi;
}

let apis: ReadonlyMap<DeclaredApi, ReadonlyMap<string, DeclaredMethod>> | undefined;

function isDeclaredApi(name: string): name is DeclaredApi {
	return Object.hasOwn(API_LABELS, name);
}

function keyName(key: t.Expression): string | undefined {
	if (key.type === "Identifier") return key.name;
	if (key.type === "StringLiteral") return key.value;
	return undefined;
}

/** Union of the object types among `shapes`; undefined when none is one. */
function merge(shapes: readonly (Shape | undefined)[]): Shape | undefined {
	let merged: Map<string, Shape | undefined> | undefined;
	for (const shape of shapes) {
		if (!shape) continue;
		merged ??= new Map();
		for (const [key, nested] of shape) merged.set(key, merge([merged.get(key), nested]));
	}
	return merged;
}

/** Parse the declarations once per process into every checked API's methods and parameter shapes. */
function declaredApis(): ReadonlyMap<DeclaredApi, ReadonlyMap<string, DeclaredMethod>> {
	if (apis) return apis;
	// Lazy: the parser stays off the launch graph until a browser call is checked.
	const { parse } = require("@babel/parser") as typeof BabelParser;
	const program = parse(declarationsSource as string, {
		sourceType: "module",
		plugins: [["typescript", { dts: true }]],
	}).program;
	const interfaces = new Map<string, { members: t.TSTypeElement[]; bases: string[] }>();
	const aliases = new Map<string, t.TSType>();
	let browserMembers: t.TSTypeElement[] = [];
	for (const node of program.body) {
		if (node.type === "TSInterfaceDeclaration") {
			interfaces.set(node.id.name, {
				members: node.body.body,
				bases: (node.extends ?? []).flatMap(base =>
					base.expression.type === "Identifier" ? [base.expression.name] : [],
				),
			});
		} else if (node.type === "TSTypeAliasDeclaration") {
			aliases.set(node.id.name, node.typeAnnotation);
		} else if (node.type === "VariableDeclaration") {
			// `declare const browser: { … }`
			const id = node.declarations[0]?.id;
			const annotation = id?.type === "Identifier" ? id.typeAnnotation : undefined;
			if (annotation?.type === "TSTypeAnnotation" && annotation.typeAnnotation.type === "TSTypeLiteral")
				browserMembers = annotation.typeAnnotation.members;
		}
	}

	// `path` holds the names being resolved, so a recursive type ends as "not an object" instead of looping.
	const membersShape = (members: readonly t.TSTypeElement[], path: readonly string[]): Shape | undefined => {
		const shape = new Map<string, Shape | undefined>();
		for (const member of members) {
			// An index or call signature makes the type open or callable, not an options bag.
			if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature") return undefined;
			const key = keyName(member.key);
			if (key === undefined) return undefined;
			const value = member.type === "TSPropertySignature" ? member.typeAnnotation?.typeAnnotation : undefined;
			shape.set(key, shapeOf(value, path));
		}
		return shape;
	};

	const namedShape = (name: string, path: readonly string[]): Shape | undefined => {
		if (path.includes(name)) return undefined;
		const inner = [...path, name];
		const alias = aliases.get(name);
		if (alias) return shapeOf(alias, inner);
		const declared = interfaces.get(name);
		if (!declared) return undefined;
		// Base keys first, so a refusal reads in the order the declarations build the type.
		const parts = [...declared.bases.map(base => namedShape(base, inner)), membersShape(declared.members, inner)];
		return parts.every(part => part !== undefined) ? merge(parts) : undefined;
	};

	/** The keys of a closed object type; undefined for anything else (primitives, arrays, functions, records). */
	const shapeOf = (type: t.TSType | undefined, path: readonly string[] = []): Shape | undefined => {
		switch (type?.type) {
			case "TSParenthesizedType":
				return shapeOf(type.typeAnnotation, path);
			case "TSTypeLiteral":
				return membersShape(type.members, path);
			case "TSIntersectionType": {
				const parts = type.types.map(part => shapeOf(part, path));
				return parts.every(part => part !== undefined) ? merge(parts) : undefined;
			}
			// `string | { title?: string }`: an object argument meets the object members.
			case "TSUnionType":
				return merge(type.types.map(part => shapeOf(part, path)));
			case "TSTypeReference": {
				if (type.typeName.type !== "Identifier") return undefined;
				if (type.typeName.name !== "Omit") return namedShape(type.typeName.name, path);
				const [base, omitted] = type.typeParameters?.params ?? [];
				const shape = shapeOf(base, path);
				const dropped = (omitted?.type === "TSUnionType" ? omitted.types : [omitted]).flatMap(part =>
					part?.type === "TSLiteralType" && part.literal.type === "StringLiteral" ? [part.literal.value] : [],
				);
				return shape && new Map([...shape].filter(([key]) => !dropped.includes(key)));
			}
			default:
				return undefined;
		}
	};

	/** The declared API a method resolves to: the first API interface its awaited return type names. */
	const returnedApi = (type: t.TSType | undefined): DeclaredApi | undefined => {
		if (type?.type === "TSUnionType") return type.types.map(returnedApi).find(api => api !== undefined);
		if (type?.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return undefined;
		if (type.typeName.name === "Promise") return returnedApi(type.typeParameters?.params[0]);
		return isDeclaredApi(type.typeName.name) ? type.typeName.name : undefined;
	};

	/** Methods by name, overloads merged; a derived interface's declaration of a name replaces its base's. */
	const methodsOf = (members: readonly t.TSTypeElement[], bases: readonly string[]): Map<string, DeclaredMethod> => {
		const methods = new Map<string, DeclaredMethod>();
		for (const member of members) {
			const name = member.type === "TSMethodSignature" ? keyName(member.key) : undefined;
			if (member.type !== "TSMethodSignature" || name === undefined) continue;
			const method = methods.get(name) ?? {
				parameters: [],
				returns: returnedApi(member.typeAnnotation?.typeAnnotation),
			};
			member.parameters.forEach((parameter, index) => {
				// A rest parameter takes values, not an options bag.
				if (parameter.type !== "Identifier") return;
				const annotation = parameter.typeAnnotation;
				const shape = annotation?.type === "TSTypeAnnotation" ? shapeOf(annotation.typeAnnotation) : undefined;
				const known = method.parameters[index];
				method.parameters[index] = { name: known?.name ?? parameter.name, shape: merge([known?.shape, shape]) };
			});
			methods.set(name, method);
		}
		for (const base of bases) {
			const declared = interfaces.get(base);
			if (!declared) continue;
			for (const [name, method] of methodsOf(declared.members, declared.bases))
				if (!methods.has(name)) methods.set(name, method);
		}
		return methods;
	};

	const index = new Map<DeclaredApi, ReadonlyMap<string, DeclaredMethod>>();
	for (const api of Object.keys(API_LABELS)) {
		if (!isDeclaredApi(api)) continue;
		const declared = interfaces.get(api);
		index.set(
			api,
			api === "browser" ? methodsOf(browserMembers, []) : methodsOf(declared?.members ?? [], declared?.bases ?? []),
		);
	}
	apis = index;
	return apis;
}

/** An object literal from any realm: run-scope code builds its options in another context. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function checkShape(where: string, shape: Shape, value: unknown): void {
	if (!isPlainObject(value)) return;
	const unknown = Object.keys(value).filter(key => !shape.has(key));
	if (unknown.length > 0) {
		throw new ToolError(
			`Unknown option${unknown.length === 1 ? "" : "s"} ${unknown.map(key => JSON.stringify(key)).join(", ")} for ${where}): it takes ${[...shape.keys()].join(", ")}.`,
		);
	}
	for (const [key, nested] of shape) if (nested) checkShape(`${where}.${key}`, nested, value[key]);
}

function checkMethod(api: DeclaredApi, method: string, declared: DeclaredMethod, args: readonly unknown[]): void {
	declared.parameters.forEach(({ name, shape }, index) => {
		if (shape) checkShape(`${API_LABELS[api]}.${method}(${name}`, shape, args[index]);
	});
}

/** Refuse any object-argument key `api.method` does not declare, naming it and the keys it does. */
export function checkDeclaredArguments(api: DeclaredApi, method: string, args: readonly unknown[]): void {
	const declared = declaredApis().get(api)?.get(method);
	if (declared) checkMethod(api, method, declared, args);
}

/**
 * `target` as its declared API: every declared method checks its arguments
 * before it runs, and a handle it resolves to (`tab.ref()`'s element,
 * `tab.frame()`'s frame) is checked the same way.
 */
export function withDeclaredArguments<T extends object>(api: DeclaredApi, target: T): T {
	const methods = declaredApis().get(api);
	if (!methods) return target;
	const wrappers = new Map<string, (...args: unknown[]) => unknown>();
	return new Proxy(target, {
		get(current, prop) {
			const value: unknown = Reflect.get(current, prop, current);
			const declared = typeof prop === "string" ? methods.get(prop) : undefined;
			if (typeof prop !== "string" || !declared || typeof value !== "function") return value;
			let wrapper = wrappers.get(prop);
			if (!wrapper) {
				wrapper = (...args: unknown[]): unknown => {
					checkMethod(api, prop, declared, args);
					const result: unknown = Reflect.apply(value, current, args);
					const returns = declared.returns;
					// A thenable, not `instanceof Promise`: a run swaps the global Promise for a tracking one.
					const then = result !== null && typeof result === "object" ? Reflect.get(result, "then") : undefined;
					if (!returns || typeof then !== "function") return result;
					return Promise.resolve(result).then((resolved: unknown) =>
						resolved !== null && typeof resolved === "object"
							? withDeclaredArguments(returns, resolved)
							: resolved,
					);
				};
				wrappers.set(prop, wrapper);
			}
			return wrapper;
		},
	});
}
