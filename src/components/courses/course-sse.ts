// Minimal Server-Sent Events reader for the Zuey AI chat stream (mirrors the parser in ZueyAiPanel).

export interface SseEvent { event: string; data: unknown }

/** Yields {event, data} for each complete frame; comment/keep-alive lines are ignored, bad JSON becomes null. */
export async function* readSse(res: Response): AsyncGenerator<SseEvent, void, undefined> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(data.join('\n'));
        } catch {
          parsed = null;
        }
        yield { event, data: parsed };
      }
      idx = buffer.indexOf('\n\n');
    }
  }
}

/** Vietnamese copy for chat error codes, with whether the fix is buying/upgrading a plan. */
export function tutorErrorCopy(code: string): { text: string; upgrade: boolean } {
  switch (code) {
    case 'ai_quota_exceeded':
    case 'ai_budget_exceeded':
      return { text: 'Bạn đã dùng hết lượt Zuey AI của tháng này. Lượt mới được cấp đầu tháng sau, hoặc nâng gói để có thêm lượt.', upgrade: true };
    case 'entitlement_required':
    case 'insufficient_scope':
      return { text: 'Hỏi Zuey AI cần gói có Zuey AI (Zuey AI, Kết hợp hoặc Cộng đồng).', upgrade: true };
    case 'ai_unconfigured':
      return { text: 'Zuey AI tạm thời chưa sẵn sàng. Vui lòng thử lại sau.', upgrade: false };
    case 'chat_run_in_progress':
      return { text: 'Zuey AI đang trả lời câu trước. Đợi một chút rồi hỏi tiếp nhé.', upgrade: false };
    case 'network_error':
      return { text: 'Mất kết nối khi đang nhận câu trả lời. Kiểm tra mạng và thử lại.', upgrade: false };
    case 'rate_limited':
      return { text: 'Bạn hỏi hơi nhanh. Đợi ít giây rồi thử lại.', upgrade: false };
    default:
      return code.startsWith('lesson_')
        ? { text: 'Bạn cần quyền đọc bài học này để hỏi Zuey AI về nó.', upgrade: false }
        : { text: 'Zuey AI chưa trả lời được. Vui lòng thử lại.', upgrade: false };
  }
}
