// The settings of his MCP servers (§5.4 "Tools", P15), under `mcp` in a config file.

import { worded } from "./entry";
import { MCP_WORDS } from "./mcp-words";

export const MCP = worded(
  {
    // A server started by a command loads its runtime first (npx, uvx): half a minute covers a cold start.
    startTimeout: { key: "mcp.startTimeout", takes: { type: "whole", least: 1 }, default: 30, perConnection: false, at: "mcpStartTimeout", ms: true },
    // A server's tool may do real work (a search, a build): a minute, twice a command tool's.
    callTimeout: { key: "mcp.callTimeout", takes: { type: "whole", least: 1 }, default: 60, perConnection: false, at: "mcpCallTimeout", ms: true },
  },
  MCP_WORDS,
);
