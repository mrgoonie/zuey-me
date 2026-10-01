import type { McpToolModule } from './types';
import { readsMcpModule } from '../reads/mcp';
import { workflowsMcpModule } from '../workflows/mcp';

/** Feature tool modules served by /api/mcp in addition to the built-in profile/link tools. */
export const MCP_FEATURE_MODULES: McpToolModule[] = [readsMcpModule, workflowsMcpModule];
