import assert from "node:assert/strict";
import test from "node:test";
import { isMcpMutationTool, parseMcpToolAllowlist } from "../src/mcpClient.ts";

test("parses MCP tool allowlists and blocks mutating tools by default", () => {
  assert.deepEqual(parseMcpToolAllowlist("bitable_v1_app_get, bitable_v1_app_table_list"), new Set(["bitable_v1_app_get", "bitable_v1_app_table_list"]));
  assert.equal(parseMcpToolAllowlist(""), undefined);
  assert.equal(isMcpMutationTool("bitable_v1_app_table_field_delete"), true);
  assert.equal(isMcpMutationTool("bitable_v1_app_table_record_search"), false);
});
