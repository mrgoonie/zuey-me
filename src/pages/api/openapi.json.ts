import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'Zuey.me Personal Linktree & Management API',
      version: '1.0.0',
      description: 'Official programmatic API for Duy Nguyen (/zuey/) profile, links, layout ordering, themes, and agent tools.',
      contact: {
        name: 'Duy Nguyen',
        email: 'hi@zuey.me',
        url: 'https://zuey.me'
      }
    },
    servers: [
      {
        url: 'https://zuey.me',
        description: 'Production Edge Server'
      },
      {
        url: 'http://localhost:4321',
        description: 'Local Development Server'
      }
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'API-Key',
          description: 'Pass secret API key as `Authorization: Bearer zuey_...`'
        },
        ApiKeyHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Pass secret API key in `X-API-Key` header'
        }
      },
      schemas: {
        Profile: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            handle: { type: 'string' },
            email: { type: 'string' },
            avatar_url: { type: 'string' },
            intro_en: { type: 'string' },
            intro_vi: { type: 'string' },
            theme: { type: 'string' },
            custom_css: { type: 'string' }
          }
        },
        LinkItem: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            section: { type: 'string', enum: ['blogs', 'companies', 'products', 'socials'] },
            title_en: { type: 'string' },
            title_vi: { type: 'string' },
            subtitle_en: { type: 'string' },
            subtitle_vi: { type: 'string' },
            url: { type: 'string' },
            icon: { type: 'string' },
            order_index: { type: 'integer' },
            is_active: { type: 'boolean' },
            click_count: { type: 'integer' }
          }
        }
      }
    },
    paths: {
      '/api/v1/profile': {
        get: {
          summary: 'Get Public Profile',
          description: 'Retrieves current biography, avatar, theme and contact info.',
          responses: {
            '200': {
              description: 'Profile data',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: { $ref: '#/components/schemas/Profile' }
                    }
                  }
                }
              }
            }
          }
        },
        put: {
          summary: 'Update Profile Info',
          description: 'Updates bio, name, avatar, or theme (Requires API key).',
          security: [{ BearerAuth: [] }, { ApiKeyHeader: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    intro_en: { type: 'string' },
                    intro_vi: { type: 'string' },
                    avatar_url: { type: 'string' },
                    theme: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Updated successfully' },
            '401': { description: 'Unauthorized' }
          }
        }
      },
      '/api/v1/links': {
        get: {
          summary: 'List All Links',
          description: 'Returns all link cards sorted by section and order index.',
          responses: {
            '200': {
              description: 'List of links',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/LinkItem' }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        post: {
          summary: 'Create a New Link',
          description: 'Adds a new link card to blogs, companies, or products.',
          security: [{ BearerAuth: [] }, { ApiKeyHeader: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['section', 'title_en', 'url'],
                  properties: {
                    section: { type: 'string', enum: ['blogs', 'companies', 'products'] },
                    title_en: { type: 'string' },
                    title_vi: { type: 'string' },
                    subtitle_en: { type: 'string' },
                    subtitle_vi: { type: 'string' },
                    url: { type: 'string' },
                    icon: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            '201': { description: 'Link created' },
            '401': { description: 'Unauthorized' }
          }
        }
      },
      '/api/v1/links/{id}': {
        put: {
          summary: 'Update Link',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          security: [{ BearerAuth: [] }, { ApiKeyHeader: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LinkItem' }
              }
            }
          },
          responses: {
            '200': { description: 'Updated' },
            '404': { description: 'Not found' }
          }
        },
        delete: {
          summary: 'Delete Link',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          security: [{ BearerAuth: [] }, { ApiKeyHeader: [] }],
          responses: {
            '200': { description: 'Deleted' },
            '401': { description: 'Unauthorized' }
          }
        }
      },
      '/api/v1/links/reorder': {
        post: {
          summary: 'Reorder Links',
          description: 'Updates ordering index for a list of link IDs.',
          security: [{ BearerAuth: [] }, { ApiKeyHeader: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['order'],
                  properties: {
                    order: {
                      type: 'array',
                      items: { type: 'string' }
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Reordered successfully' }
          }
        }
      },
      '/api/v1/theme': {
        get: {
          summary: 'Get Theme Configuration',
          responses: { '200': { description: 'Theme data' } }
        },
        put: {
          summary: 'Update Theme Configuration',
          security: [{ BearerAuth: [] }],
          responses: { '200': { description: 'Theme updated' } }
        }
      },
      '/api/v1/keys': {
        get: {
          summary: 'List API Keys',
          security: [{ BearerAuth: [] }],
          responses: { '200': { description: 'Keys list' } }
        },
        post: {
          summary: 'Create API Key',
          security: [{ BearerAuth: [] }],
          responses: { '201': { description: 'Key created with secret token' } }
        }
      }
    }
  };

  return new Response(JSON.stringify(spec, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
