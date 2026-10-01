# Wave M: Spritesheet mascot Zuey (codex CLI)

Ngày: 2026-10-01 23:58 → 2026-10-02 00:10 (Asia/Saigon)
Nhánh: worktree agent dựa trên `claude/zuey-membership-implementation-ev50kx` (1483b37)

## Kết quả

- **Codex CLI đã tạo được ảnh thật.** Dùng `codex-cli 0.159.3` và `codex exec` với feature
  `image_generation` (stable, đang bật), model `gpt-6.1-sol`, session `01a0f867-9002-74f0-8437-85fa2adf1afb`.
- Ảnh tham chiếu là `plans/visuals/assets/zuey-companion-sprites.png` (atlas prototype 4×4, 1254², có alpha).
- Codex render ba ứng viên và chọn bản thứ hai (`exec-cc96a70c…`). Bản này giữ đúng tay vẫy và đúng nét mặt.
  sha256 của nó là `2f98949a…0410271`.
- Script `scripts/build-mascot-atlas.py` hậu xử lý tất định (Pillow, numpy, scipy). Chạy hai lần cho
  sha256 giống hệt nhau. Các bước:
  - tách lưới 4×4 và xoá nền xanh thành alpha (un-mix màu key ở viền, despill);
  - lọc đốm rời;
  - chuẩn hoá chiều cao giữa các hàng;
  - dùng một scale chung, căn baseline và pivot ở chân;
  - đóng gói 1024×1024, xuất WebP và PNG;
  - QA, và báo fail nếu lệch quá 2 px.

## File

- `public/mascot/zuey-mascot.webp`: 194,716 B (dưới 1.5 MB).
- `public/mascot/zuey-mascot.png`: 848,614 B, bản fallback.
- `public/mascot/manifest.json`: kích thước ảnh, cell 256×256, pivot (128, 244), baseline 244,
  `frames`, `animations` (gồm frames {x,y,w,h,durationMs}, loop, fps, reducedMotionFrame),
  `expressions`, `build` (hash nguồn, scale, rowFactors) và `qa`.
- `public/mascot/raw/codex-spritesheet.png`: output gốc của codex, giữ lại để build lại được.
- `scripts/build-mascot-atlas.py`: script hậu xử lý.
- `docs/mascot-provenance.md`: lệnh codex, prompt nguyên văn, phiên bản, ngày, các ứng viên,
  các bước hậu xử lý và QA.

## Trạng thái và animation (lấy từ JS của preview)

| Trạng thái UI | Animation | Frame | Loop | fps |
|---|---|---|---|---|
| idle | idle | idle-0, blink, breathe, idle-1 (1400/140/700/1100 ms) | có | 1.2 |
| walking | walk | 4 pha, 125 ms mỗi pha, hướng phải | có | 8 |
| wave | wave | 0→1→2→1→2→3 | không | 4.69 |
| talking | talk | talking ↔ idle-0 (nhép miệng) | có | 6.25 |
| thinking / happy / surprised | cùng tên | 1 frame tĩnh | không | — |

Map thời tiết trong preview: nắng → happy, mưa → thinking, tuyết → surprised. Cả ba đều có frame tương ứng.

## Số đo QA (16 frame)

- Baseline lệch tối đa **0 px**. Pivot-x lệch tối đa **1.44 px** (ngưỡng ±2 px).
- Nhân vật đứng cao 238–239 px. Frame đi bộ cao 232–234 px, thấp hơn do sải chân.
- Không frame nào chạm mép cell.
- Đã kiểm tra bằng mắt trên nền tối và nền sáng: không còn viền xanh, không còn đốm.
  Atlas prototype cũ có đốm đỏ và vàng; script cũng lọc sạch nếu dùng làm input.

## Kiểm tra

- `bun test`: 86 pass, 0 fail.
- `bun run build`: astro check có 0 lỗi, 0 cảnh báo, 0 hint; build hoàn tất.
  Phải chạy `bun install --frozen-lockfile` trước vì worktree chưa có dependencies.

## Lưu ý

- Lần chạy đầu thất bại do `-i <FILE>...` nhận nhiều giá trị và nuốt mất prompt
  (`No prompt provided via stdin.`). Cách sửa: đặt prompt trước `-i`.
- Trên Windows, sandbox shell của codex lỗi (`CreateProcessAsUserW failed: 5 (Access is denied.)`).
  Công cụ tạo ảnh vẫn chạy được. MCP Cloudflare của codex báo `AuthRequired`, không ảnh hưởng.
- Codex tự nhận nền xanh chưa phẳng tuyệt đối và baseline chưa chuẩn. Script hậu xử lý đã xử lý cả hai.
- Frame đi bộ chỉ hướng phải. Runtime phải lật bằng `scaleX(-1)` khi đi sang trái, giống preview.
- Chưa tích hợp vào UI. Wave này chỉ tạo asset, manifest và provenance.

## Câu hỏi mở

- Có nên giữ `public/mascot/raw/` (1.67 MB, sẽ deploy công khai) hay chuyển ra ngoài `public/`?
  Hiện giữ để tái lập build theo đúng yêu cầu "ghi lại output".
