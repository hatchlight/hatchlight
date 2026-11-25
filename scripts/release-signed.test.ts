import { describe, expect, test } from "bun:test";
import { type LatestJson, signedFileOf, withReplaced } from "./release-signed";

/** A signature shaped like Tauri's: base64 of minisign text naming the file. */
const signatureFor = (file: string, mark = "a") =>
	Buffer.from(
		`untrusted comment: signature from tauri secret key\nRUT${mark}\ntrusted comment: timestamp:1795572848\tfile:${file}\tversion:0.4.2\nAAAA\n`,
	).toString("base64");

const latest = (): LatestJson => ({
	version: "0.4.2",
	platforms: {
		"windows-x86_64": {
			signature: signatureFor("Hatchlight_0.4.2_x64-setup.exe"),
			url: "https://api.github.com/repos/hatchlight/hatchlight/releases/assets/1",
		},
		"windows-x86_64-nsis": {
			signature: signatureFor("Hatchlight_0.4.2_x64-setup.exe"),
			url: "https://api.github.com/repos/hatchlight/hatchlight/releases/assets/1",
		},
		"windows-x86_64-msi": {
			signature: signatureFor("Hatchlight_0.4.2_x64_en-US.msi"),
			url: "https://api.github.com/repos/hatchlight/hatchlight/releases/assets/2",
		},
		"linux-x86_64": {
			signature: signatureFor("Hatchlight_0.4.2_amd64.AppImage"),
			url: "https://api.github.com/repos/hatchlight/hatchlight/releases/assets/3",
		},
	},
});

describe("release-signed", () => {
	test("reads the file name out of a Tauri signature", () => {
		expect(signedFileOf(signatureFor("Hatchlight_0.4.2_x64-setup.exe"))).toBe(
			"Hatchlight_0.4.2_x64-setup.exe",
		);
		expect(signedFileOf("not base64 of a signature")).toBeNull();
	});

	test("points every platform of a replaced file at the new asset", () => {
		const setup = {
			signature: signatureFor("Hatchlight_0.4.2_x64-setup.exe", "b"),
			url: "https://api.github.com/repos/hatchlight/hatchlight/releases/assets/10",
		};
		const msi = {
			signature: signatureFor("Hatchlight_0.4.2_x64_en-US.msi", "b"),
			url: "https://api.github.com/repos/hatchlight/hatchlight/releases/assets/11",
		};
		const next = withReplaced(
			latest(),
			new Map([
				["Hatchlight_0.4.2_x64-setup.exe", setup],
				["Hatchlight_0.4.2_x64_en-US.msi", msi],
			]),
		);
		expect(next.platforms["windows-x86_64"]).toEqual(setup);
		expect(next.platforms["windows-x86_64-nsis"]).toEqual(setup);
		expect(next.platforms["windows-x86_64-msi"]).toEqual(msi);
		expect(next.platforms["linux-x86_64"]).toEqual(
			latest().platforms["linux-x86_64"],
		);
		expect(next.version).toBe("0.4.2");
	});

	test("refuses a replaced file that no platform offers", () => {
		expect(() =>
			withReplaced(
				latest(),
				new Map([["Other.exe", { signature: "x", url: "y" }]]),
			),
		).toThrow("Other.exe");
	});
});
