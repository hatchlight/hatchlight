import desktop from "../../../apps/desktop/package.json" with { type: "json" };

/**
 * Hatchlight's version: the desktop app's, which every release sets. The
 * server, the command line and the MCP server report this one number.
 */
export const APP_VERSION: string = desktop.version;
