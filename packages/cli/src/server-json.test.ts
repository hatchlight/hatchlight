import { describe, expect, test } from "bun:test";
import { APP_VERSION } from "@hatchlight/core";
import registryEntry from "../../../server.json" with { type: "json" };

// server.json is Hatchlight's entry in the official MCP Registry; the release
// workflow publishes it with the npm package of the same version.
describe("server.json", () => {
	test("has the app's version, for itself and its npm package", () => {
		expect(registryEntry.version).toBe(APP_VERSION);
		expect(registryEntry.packages.map((p) => p.version)).toEqual([APP_VERSION]);
	});

	test("names the npm package and runs its MCP server", () => {
		const [npm] = registryEntry.packages;
		expect(npm?.registryType).toBe("npm");
		expect(npm?.identifier).toBe("hatchlight");
		expect(npm?.packageArguments).toEqual([
			{ type: "positional", value: "mcp" },
		]);
	});

	test("fits the registry's limits", () => {
		expect(registryEntry.name).toBe("io.github.hatchlight/hatchlight");
		expect(registryEntry.description.length).toBeLessThanOrEqual(100);
	});
});
