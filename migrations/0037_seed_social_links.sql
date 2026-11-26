-- Social icon row under the profile bio becomes editable link rows (section 'socials').
INSERT OR IGNORE INTO links (id, section, title_en, title_vi, url, icon, order_index, is_active) VALUES
  ('social-ig', 'socials', 'Instagram', 'Instagram', 'https://www.instagram.com/imzuey', 'instagram', 1, 1),
  ('social-tiktok', 'socials', 'TikTok', 'TikTok', 'https://www.tiktok.com/@mrgoonvn', 'tiktok', 2, 1),
  ('social-whatsapp', 'socials', 'WhatsApp (@imzuey)', 'WhatsApp (@imzuey)', 'https://wa.me/imzuey', 'whatsapp', 3, 1),
  ('social-youtube', 'socials', 'YouTube', 'YouTube', 'https://youtube.com/@imzuey', 'youtube', 4, 1),
  ('social-fb', 'socials', 'Facebook', 'Facebook', 'https://fb.com/mrgoonie', 'facebook', 5, 1),
  ('social-threads', 'socials', 'Threads', 'Threads', 'https://www.threads.com/@imzuey', 'threads', 6, 1),
  ('social-x', 'socials', 'X (Twitter)', 'X (Twitter)', 'https://x.com/zueydotme', 'x', 7, 1);
