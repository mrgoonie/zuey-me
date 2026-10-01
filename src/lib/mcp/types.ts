import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import type { Principal } from '../members/policy';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpContext {
  request: Request;
  env: RuntimeEnv;
  d1?: D1DatabaseLike;
  /** Throws AppError(401/403) unless the caller is a Studio session or admin API key. */
  requireAdmin(): Promise<void>;
  /** True when the caller is an admin (does not throw). */
  isAdmin(): Promise<boolean>;
  /** The caller resolved by the central membership policy (memoised per request). */
  principal?(): Promise<Principal>;
}

/** A feature module contributes tools and handles calls for the tool names it owns. */
export interface McpToolModule {
  tools: McpTool[];
  call(name: string, args: Record<string, unknown>, ctx: McpContext): Promise<unknown>;
}
