import { expect, test } from "bun:test";
import { providerContract } from "./contract";
import { FalProvider } from "./fal";
import { collect, ctx, modelOf as model, params, scripted } from "./testing";

providerContract(new FalProvider());

const BASE = "https://queue.fal.run/fal-ai/flux/requests/r1";
const SUBMITTED = {
	status: "IN_QUEUE",
	request_id: "r1",
	response_url: BASE,
	status_url: `${BASE}/status`,
	cancel_url: `${BASE}/cancel`,
};

test("submits to the model endpoint and follows the queue to the images", async () => {
	const { fetch, calls } = scripted([
		[200, SUBMITTED],
		[200, { status: "IN_QUEUE", queue_position: 2 }],
		[200, { status: "IN_PROGRESS" }],
		[200, { status: "COMPLETED" }],
		[
			200,
			{
				images: [
					{ url: "https://v3.fal.media/a.png", content_type: "image/png" },
				],
			},
		],
	]);
	const fal = new FalProvider(fetch, 0);
	const handle = await fal.submit(
		{
			model: model(fal, "fal/fal-ai/flux/schnell"),
			params: params({ aspectRatio: "16:9", seed: 7, count: 2 }),
			references: [],
		},
		ctx(),
	);

	expect(calls[0]).toEqual({
		url: "https://queue.fal.run/fal-ai/flux/schnell",
		method: "POST",
		auth: "Key k",
		body: {
			prompt: "a red fox",
			num_images: 2,
			output_format: "png",
			image_size: "landscape_16_9",
			seed: 7,
		},
	});
	// The handle must survive being stored and read back.
	const restored = JSON.parse(JSON.stringify(handle));

	expect(await collect(fal.events(restored, ctx()))).toEqual([
		{
			type: "progress",
			message: "In queue (position 2)",
			stage: "queued",
			position: 2,
		},
		{ type: "progress", message: "Generating", stage: "generating" },
		{
			type: "completed",
			outputs: [{ url: "https://v3.fal.media/a.png", mime: "image/png" }],
		},
	]);
	expect(calls.slice(1).map((c) => c.url)).toEqual([
		`${BASE}/status`,
		`${BASE}/status`,
		`${BASE}/status`,
		BASE,
	]);
	expect(calls.every((c) => c.auth === "Key k")).toBe(true);
});

test("editing uses the edit endpoint and sends the references", async () => {
	const { fetch, calls } = scripted([[200, SUBMITTED]]);
	const fal = new FalProvider(fetch, 0);
	await fal.submit(
		{
			model: model(fal, "fal/fal-ai/nano-banana"),
			params: params({ aspectRatio: "4:5" }),
			references: [{ data: new Uint8Array([1, 2, 3]), mime: "image/png" }],
		},
		ctx(),
	);
	expect(calls[0]?.url).toBe("https://queue.fal.run/fal-ai/nano-banana/edit");
	expect(calls[0]?.body).toMatchObject({
		aspect_ratio: "4:5",
		image_urls: ["data:image/png;base64,AQID"],
	});
});

test("a guide picture switches Z-Image Turbo to its ControlNet, which makes the map", async () => {
	const { fetch, calls } = scripted([
		[200, SUBMITTED],
		[200, SUBMITTED],
		[200, SUBMITTED],
	]);
	const fal = new FalProvider(fetch, 0);
	const zImage = model(fal, "fal/fal-ai/z-image/turbo");
	expect(zImage.capabilities.guide).toEqual({
		kinds: ["outlines", "pose", "depth"],
		makesMaps: ["outlines", "pose", "depth"],
		strength: 0.75,
	});
	const guide = { data: new Uint8Array([1, 2, 3]), mime: "image/png" };
	await fal.submit(
		{
			model: zImage,
			params: params({
				guide: { assetId: "g", kind: "pose", ready: false, strength: 0.6 },
			}),
			references: [],
			guide,
		},
		ctx(),
	);
	await fal.submit(
		{
			model: zImage,
			params: params({
				guide: { assetId: "g", kind: "depth", ready: true, strength: 0.75 },
			}),
			references: [],
			guide,
		},
		ctx(),
	);
	await fal.submit(
		{ model: zImage, params: params({ aspectRatio: "16:9" }), references: [] },
		ctx(),
	);
	expect(calls[0]?.url).toBe(
		"https://queue.fal.run/fal-ai/z-image/turbo/controlnet",
	);
	expect(calls[0]?.body).toEqual({
		prompt: "a red fox",
		num_images: 1,
		output_format: "png",
		image_url: "data:image/png;base64,AQID",
		preprocess: "pose",
		control_scale: 0.6,
	});
	// A ready map is used as it is.
	expect(calls[1]?.body).toMatchObject({
		preprocess: "none",
		control_scale: 0.75,
	});
	// Without a guide, the plain model, at the ratio asked.
	expect(calls[2]?.url).toBe("https://queue.fal.run/fal-ai/z-image/turbo");
	expect(calls[2]?.body).toMatchObject({ image_size: "landscape_16_9" });
	expect(Object.keys(calls[2]?.body as object)).not.toContain("image_url");
});

test("Ideogram Character keeps the person in its one reference", async () => {
	const { fetch, calls } = scripted([[200, SUBMITTED]]);
	const fal = new FalProvider(fetch, 0);
	const character = model(fal, "fal/fal-ai/ideogram/character");
	expect(character.capabilities.maxReferenceImages).toBe(1);
	await fal.submit(
		{
			model: character,
			params: params({ aspectRatio: "3:4" }),
			references: [{ data: new Uint8Array([1, 2, 3]), mime: "image/jpeg" }],
		},
		ctx(),
	);
	expect(calls[0]?.url).toBe("https://queue.fal.run/fal-ai/ideogram/character");
	expect(calls[0]?.body).toMatchObject({
		reference_image_urls: ["data:image/jpeg;base64,AQID"],
		image_size: "portrait_4_3",
	});
	// Without one there is nobody to keep: refused before anything is sent.
	await expect(
		fal.submit({ model: character, params: params(), references: [] }, ctx()),
	).rejects.toMatchObject({ code: "needsPicture" });
	expect(calls).toHaveLength(1);
});

test("a rejected submission surfaces fal's message", async () => {
	const { fetch } = scripted([[401, { detail: "Invalid key" }]]);
	const fal = new FalProvider(fetch, 0);
	expect(
		fal.submit(
			{
				model: model(fal, "fal/fal-ai/flux/dev"),
				params: params(),
				references: [],
			},
			ctx(),
		),
	).rejects.toThrow("Invalid key");
});

test("a request that fails in the queue is reported as failed", async () => {
	const handle = {
		statusUrl: `${BASE}/status`,
		responseUrl: BASE,
		cancelUrl: `${BASE}/cancel`,
	};
	const failedInQueue = scripted([
		[200, { status: "COMPLETED", error: "Request timed out" }],
	]);
	expect(
		await collect(
			new FalProvider(failedInQueue.fetch, 0).events(handle, ctx()),
		),
	).toEqual([{ type: "failed", error: "Request timed out" }]);

	const failedResult = scripted([
		[200, { status: "COMPLETED" }],
		[422, { detail: [{ msg: "prompt flagged" }] }],
	]);
	const events = await collect(
		new FalProvider(failedResult.fetch, 0).events(handle, ctx()),
	);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({ type: "failed" });
	expect(JSON.stringify(events[0])).toContain("prompt flagged");
});

test("cancel calls the request's cancel URL", async () => {
	const { fetch, calls } = scripted([
		[202, { status: "CANCELLATION_REQUESTED" }],
	]);
	await new FalProvider(fetch, 0).cancel(
		{
			statusUrl: `${BASE}/status`,
			responseUrl: BASE,
			cancelUrl: `${BASE}/cancel`,
		},
		ctx(),
	);
	expect(calls[0]).toMatchObject({
		url: `${BASE}/cancel`,
		method: "PUT",
		auth: "Key k",
	});
});

test("never sends the key to a URL outside fal's queue", async () => {
	const submit = scripted([
		[200, { ...SUBMITTED, status_url: "https://evil.example/status" }],
	]);
	const fal = new FalProvider(submit.fetch, 0);
	expect(
		fal.submit(
			{
				model: model(fal, "fal/fal-ai/flux/dev"),
				params: params(),
				references: [],
			},
			ctx(),
		),
	).rejects.toThrow("unexpected request URL");

	const follow = scripted([]);
	expect(
		collect(
			new FalProvider(follow.fetch, 0).events(
				{
					statusUrl: "https://evil.example/s",
					responseUrl: BASE,
					cancelUrl: BASE,
				},
				ctx(),
			),
		),
	).rejects.toThrow("unexpected request URL");
	expect(follow.calls).toHaveLength(0);
});

test("a transient polling error is retried instead of losing the job", async () => {
	const handle = {
		statusUrl: `${BASE}/status`,
		responseUrl: BASE,
		cancelUrl: `${BASE}/cancel`,
	};
	const flaky = scripted([
		[502, { detail: "Bad gateway" }],
		[429, { detail: "Slow down" }],
		[200, { status: "COMPLETED" }],
		[200, { images: [{ url: "https://v3.fal.media/a.png" }] }],
	]);
	const events = await collect(
		new FalProvider(flaky.fetch, 0).events(handle, ctx()),
	);
	expect(events.at(-1)).toMatchObject({ type: "completed" });

	const down = scripted(
		Array.from(
			{ length: 6 },
			() => [503, { detail: "Unavailable" }] as [number, unknown],
		),
	);
	expect(
		await collect(new FalProvider(down.fetch, 0).events(handle, ctx())),
	).toEqual([
		{
			type: "failed",
			error: "Unavailable",
			// The job may still finish at fal: trying again follows it.
			code: "connectionLost",
			params: { provider: "fal" },
		},
	]);
	expect(down.calls).toHaveLength(6);
});

test("a video is asked for by length, in the form its endpoint expects", async () => {
	const { fetch, calls } = scripted([
		[200, SUBMITTED],
		[200, SUBMITTED],
	]);
	const fal = new FalProvider(fetch, 0);
	const request = {
		params: params({ aspectRatio: "16:9", seed: 7, durationSeconds: 8 }),
		references: [],
	};
	await fal.submit({ ...request, model: model(fal, "fal/fal-ai/veo3") }, ctx());
	expect(calls[0]).toMatchObject({
		url: "https://queue.fal.run/fal-ai/veo3",
		body: {
			prompt: "a red fox",
			duration: "8s",
			aspect_ratio: "16:9",
			seed: 7,
		},
	});

	await fal.submit(
		{
			params: params({ durationSeconds: 10 }),
			references: [],
			model: model(fal, "fal/kling/v4/text-to-video"),
		},
		ctx(),
	);
	expect(calls[1]?.body).toEqual({ prompt: "a red fox", duration: 10 });
});

test("a first frame switches a video model to its image endpoint", async () => {
	const { fetch, calls } = scripted([[200, SUBMITTED]]);
	const fal = new FalProvider(fetch, 0);
	await fal.submit(
		{
			model: model(fal, "fal/fal-ai/kling-video/v2.5-turbo/pro/text-to-video"),
			params: params({ aspectRatio: "9:16", durationSeconds: 5 }),
			references: [{ data: new Uint8Array([1, 2, 3]), mime: "image/png" }],
		},
		ctx(),
	);
	expect(calls[0]?.url).toBe(
		"https://queue.fal.run/fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
	);
	// This endpoint takes its shape from the image, not from a ratio.
	expect(calls[0]?.body).toEqual({
		prompt: "a red fox",
		duration: "5",
		image_url: "data:image/png;base64,AQID",
	});
});

test("a video result is one MP4, whatever type the endpoint reports", async () => {
	const handle = {
		statusUrl: `${BASE}/status`,
		responseUrl: BASE,
		cancelUrl: `${BASE}/cancel`,
	};
	const result = async (video: object) =>
		(
			await collect(
				new FalProvider(
					scripted([
						[200, { status: "COMPLETED" }],
						[200, { video }],
					]).fetch,
					0,
				).events(handle, ctx()),
			)
		).at(-1);

	const url = "https://v3.fal.media/clip.mp4";
	expect(await result({ url })).toEqual({
		type: "completed",
		outputs: [{ url, mime: "video/mp4" }],
	});
	expect(
		await result({ url, content_type: "application/octet-stream" }),
	).toEqual({ type: "completed", outputs: [{ url, mime: "video/mp4" }] });
	expect(await result({ url, content_type: "video/webm" })).toEqual({
		type: "completed",
		outputs: [{ url, mime: "video/webm" }],
	});
});
