/// <reference path="../.astro/types.d.ts" />
import type { D1DatabaseLike } from './db/store';

declare global {
  namespace App {
    interface Locals {
      runtime?: {
        env?: {
          DB?: D1DatabaseLike;
          PUBLIC_SITE_URL?: string;
          PUBLIC_POSTHOG_KEY?: string;
          PUBLIC_POSTHOG_HOST?: string;
          GITHUB_CLIENT_ID?: string;
          GITHUB_CLIENT_SECRET?: string;
          GOOGLE_CLIENT_ID?: string;
          GOOGLE_CLIENT_SECRET?: string;
        };
      };
    }
  }
}

export {};
