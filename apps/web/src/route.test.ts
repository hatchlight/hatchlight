import { expect, test } from "bun:test";
import { parse } from "./route";

test("a broken escape in a models link opens the page instead of failing", () => {
	expect(parse("#/models/%E0")).toEqual({ view: "models" });
	expect(parse("#/models/sdxl%2Dturbo")).toEqual({
		view: "models",
		focus: "sdxl-turbo",
	});
	expect(parse("#/models")).toEqual({ view: "models" });
});
