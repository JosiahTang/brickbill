export function waitForChildClose(child, { timeoutMs, label, killGraceMs = 5_000 }) {
  if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(killGraceMs) || killGraceMs < 0
    || typeof label !== 'string' || !label)
    return Promise.reject(new Error('Compose 烟测子进程等待参数无效'));
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    let forceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* Continue to the bounded force-stop attempt. */ }
      if (settled) return;
      forceTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* The timeout remains the primary failure. */ }
        finish(reject, new Error(`${label}超过 ${timeoutMs}ms；已请求强制终止，但未收到子进程退出确认`));
      }, killGraceMs);
      forceTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      callback(value);
    };
    child.once('error', error => finish(reject, error));
    child.once('close', code => timedOut
      ? finish(reject, new Error(`${label}超过 ${timeoutMs}ms，Docker 辅助进程已退出`))
      : finish(resolve, code));
  });
}

export async function runChildProcess(child, { timeoutMs, label, command, args = [], killGraceMs = 5_000 }) {
  const code = await waitForChildClose(child, { timeoutMs, label, killGraceMs });
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} exited ${code ?? 'unknown'}`);
  return code;
}
