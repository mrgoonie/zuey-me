import type { McpToolModule } from './types';
import { readsMcpModule } from '../reads/mcp';
import { coursesMcpModule } from '../courses/course-mcp';
import { bookingMcpModule } from '../booking/mcp';
import { articlesMcpModule } from '../blocks/mcp';
import { membersMcpModule } from '../members/mcp';
import { chatMcpModule } from '../ai/mcp';
import { accountMcpModule } from '../oauth/account-mcp';
import { experienceMcpModule } from '../experience/mcp';
import { taxonomyMcpModule } from '../taxonomy/mcp';
import { videosMcpModule } from '../videos/mcp';

/** Feature tool modules served by /api/mcp and /mcp in addition to the built-in profile/link tools. */
export const MCP_FEATURE_MODULES: McpToolModule[] = [
  readsMcpModule, coursesMcpModule, bookingMcpModule, articlesMcpModule, taxonomyMcpModule, membersMcpModule,
  chatMcpModule, accountMcpModule, experienceMcpModule, videosMcpModule,
];
