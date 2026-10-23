/**
 * Accepted values for a link card's `icon`, as rendered by src/components/BrandIcons.tsx.
 * Shared by the MCP link tools and the OpenAPI link schema so both describe the same contract.
 */
export const LINK_ICON_DESCRIPTION =
  'Icon name. Brand and product marks take precedence (agentkit, dewee, tose, substack, cloud, vault, render, multix, ' +
  'anymd, motion, x, facebook, youtube, etc.); otherwise any curated Lucide icon name or alias from block_schema icons ' +
  '(e.g. rocket, database) is drawn. Note that cloud and x always render the Cloud Harness and X brand marks. ' +
  'Unknown or empty names render a neutral link mark.';
