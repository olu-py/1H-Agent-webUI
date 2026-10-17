import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.M3_PROFILE_URL ?? "http://127.0.0.1:5173/benchmarks/session-tree-profile.html";
const devtoolsPort = Number(process.env.M3_CDP_PORT ?? "9228");
const events = Number(process.env.M3_PROFILE_EVENTS ?? "500");
const variants = (process.env.M3_PROFILE_VARIANTS ?? "before,after").split(",");
const runLabel = (process.env.M3_PROFILE_RUN_LABEL ?? "m3-session-tree").replace(/[^a-zA-Z0-9_-]/g, "-");
const outputDirectory = path.resolve(import.meta.dirname, "../../design/performance");
mkdirSync(outputDirectory, { recursive: true });

async function runVariant(variant) {
  const created = await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?about:blank`, { method: "PUT" });
  if (!created.ok) throw new Error(`DevTools new target failed: ${created.status}`);
  const target = await created.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  let tracingComplete;
  const traceFinished = new Promise((resolve) => { tracingComplete = resolve; });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
    if (message.method === "Tracing.tracingComplete") tracingComplete(message.params);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await send("Page.bringToFront");
  await send("Tracing.start", {
    categories: "devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.frame",
    transferMode: "ReturnAsStream",
  });
  await send("Page.navigate", {
    url: `${baseUrl}?variant=${variant}&events=${events}`,
  });

  const started = Date.now();
  let completed = false;
  while (Date.now() - started < 120_000) {
    await delay(100);
    const value = await send("Runtime.evaluate", {
      expression: "document.body?.dataset.profileComplete === 'true'",
      returnByValue: true,
    });
    if (value.result?.value === true) {
      completed = true;
      break;
    }
  }
  if (!completed) throw new Error(`${variant} run did not complete within 120 seconds`);

  const profileResult = await send("Runtime.evaluate", {
    expression: "JSON.stringify(window.__m3Profile)",
    returnByValue: true,
  });
  const profile = JSON.parse(profileResult.result.value);
  if (variant === "after") {
    const startInteraction = await send("Runtime.evaluate", {
      expression: `(() => {
        const tree = document.querySelector('[role="tree"]');
        const active = tree?.querySelector('.session-item.active');
        const rect = active?.getBoundingClientRect();
        return {
          activeSessionVisible: Boolean(active?.isConnected),
          treeAccessible: tree?.getAttribute('aria-label') === '会话列表' && Boolean(active?.closest('[role="treeitem"]')?.getAttribute('aria-level')),
          beforeIndex: Number(active?.closest('[data-row-index]')?.getAttribute('data-row-index')),
          x: rect ? rect.left + rect.width / 2 : 0,
          y: rect ? rect.top + rect.height / 2 : 0,
        };
      })()`,
      returnByValue: true,
    });
    const startInfo = startInteraction.result.value;
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: startInfo.x, y: startInfo.y, button: "left", clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: startInfo.x, y: startInfo.y, button: "left", clickCount: 1,
    });
    const pressKey = async (key, keyCode) => {
      await send("Input.dispatchKeyEvent", {
        type: "rawKeyDown", key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp", key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      });
      await delay(80);
      const result = await send("Runtime.evaluate", {
        expression: "Number(document.activeElement?.closest('[data-row-index]')?.getAttribute('data-row-index'))",
        returnByValue: true,
      });
      return result.result.value;
    };
    const arrowUpIndex = await pressKey("ArrowUp", 38);
    const homeIndex = await pressKey("Home", 36);
    const endIndex = await pressKey("End", 35);
    const anchorBeforeResult = await send("Runtime.evaluate", {
      expression: `(() => {
        const viewport = document.querySelector('.session-tree-viewport');
        const index = Math.floor(viewport.scrollTop / 36);
        const row = document.querySelector('[data-row-index="' + index + '"]');
        return { index, sessionId: row?.getAttribute('data-session-id') || null, offset: viewport.scrollTop % 36 };
      })()`,
      returnByValue: true,
    });
    await send("Runtime.evaluate", {
      expression: "window.__m3ProfileControls.insertRoot()",
      returnByValue: true,
    });
    await delay(100);
    const anchorAfterResult = await send("Runtime.evaluate", {
      expression: `(() => {
        const viewport = document.querySelector('.session-tree-viewport');
        const index = Math.floor(viewport.scrollTop / 36);
        const row = document.querySelector('[data-row-index="' + index + '"]');
        return { index, sessionId: row?.getAttribute('data-session-id') || null, offset: viewport.scrollTop % 36 };
      })()`,
      returnByValue: true,
    });
    await delay(80);
    const interaction = await send("Runtime.evaluate", {
      expression: `(() => {
        const tree = document.querySelector('[role="tree"]');
        const focusedRow = document.activeElement?.closest('[data-row-index]');
        const viewport = document.querySelector('.session-tree-viewport');
        return {
          activeSessionVisible: Boolean(tree?.querySelector('.session-item.active')),
          treeAccessible: tree?.getAttribute('aria-label') === '会话列表',
          focusedIndex: Number(focusedRow?.getAttribute('data-row-index')),
          renderedTreeItems: tree?.querySelectorAll('[role="treeitem"]').length || 0,
          anchorSessionBefore: ${JSON.stringify(anchorBeforeResult.result.value.sessionId)},
          anchorSessionAfter: document.querySelector('[data-row-index="' + Math.floor(viewport.scrollTop / 36) + '"]')?.getAttribute('data-session-id') || null,
          anchorOffsetDelta: Math.abs((viewport.scrollTop % 36) - ${anchorBeforeResult.result.value.offset}),
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    profile.treeInteraction = {
      ...startInfo,
      arrowUpIndex,
      homeIndex,
      endIndex,
      anchorSessionBefore: anchorBeforeResult.result.value.sessionId,
      anchorSessionAfter: anchorAfterResult.result.value.sessionId,
      anchorOffsetBefore: anchorBeforeResult.result.value.offset,
      anchorOffsetAfter: anchorAfterResult.result.value.offset,
      anchorPreserved: anchorBeforeResult.result.value.sessionId === anchorAfterResult.result.value.sessionId
        && Math.abs(anchorBeforeResult.result.value.offset - anchorAfterResult.result.value.offset) < 1,
      ...interaction.result.value,
    };
    if (!profile.treeInteraction.activeSessionVisible || !profile.treeInteraction.treeAccessible
      || profile.treeInteraction.arrowUpIndex !== startInfo.beforeIndex - 1
      || profile.treeInteraction.homeIndex !== 0
      || profile.treeInteraction.endIndex !== startInfo.beforeIndex
      || !profile.treeInteraction.anchorPreserved) {
      throw new Error(`Virtual tree interaction check failed: ${JSON.stringify(profile.treeInteraction)}`);
    }
    await send("Runtime.evaluate", {
      expression: "document.querySelector('.session-tree-viewport').scrollTop = 11 * 36 + 7",
    });
    await delay(100);
    const topAnchorExpression = `(() => {
      const viewport = document.querySelector('.session-tree-viewport');
      const index = Math.floor(viewport.scrollTop / 36);
      return {
        sessionId: document.querySelector('[data-row-index="' + index + '"]')?.getAttribute('data-session-id') || null,
        offset: viewport.scrollTop % 36,
      };
    })()`;
    const topBefore = (await send("Runtime.evaluate", {
      expression: topAnchorExpression, returnByValue: true,
    })).result.value;
    await send("Runtime.evaluate", {
      expression: "window.__m3ProfileControls.insertRoot()", returnByValue: true,
    });
    await delay(100);
    const topAfter = (await send("Runtime.evaluate", {
      expression: topAnchorExpression, returnByValue: true,
    })).result.value;
    profile.treeInteraction.topAnchorBefore = topBefore;
    profile.treeInteraction.topAnchorAfter = topAfter;
    if (!topBefore.sessionId || topBefore.sessionId !== topAfter.sessionId
      || Math.abs(topBefore.offset - topAfter.offset) >= 1) {
      throw new Error(`Top-of-list anchor check failed: ${JSON.stringify({ topBefore, topAfter })}`);
    }
  }
  await send("Tracing.end");
  const traceStream = await traceFinished;
  let traceText = "";
  let eof = false;
  while (!eof) {
    const chunk = await send("IO.read", { handle: traceStream.stream, size: 4 * 1024 * 1024 });
    traceText += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString("utf8") : chunk.data;
    eof = chunk.eof;
  }
  await send("IO.close", { handle: traceStream.stream });
  socket.close();

  const trace = JSON.parse(traceText);
  const names = new Set(["UpdateLayoutTree", "RecalculateStyles", "Layout", "Paint", "CompositeLayers"]);
  const rendering = trace.traceEvents.filter((entry) => names.has(entry.name) && typeof entry.dur === "number");
  const renderDurations = Object.fromEntries([...names].map((name) => [
    name,
    {
      count: rendering.filter((entry) => entry.name === name).length,
      totalMs: rendering.filter((entry) => entry.name === name).reduce((sum, entry) => sum + entry.dur, 0) / 1000,
    },
  ]));
  const sortedCommits = profile.profiler.map((entry) => entry.actualDuration).sort((a, b) => a - b);
  const quantile = (values, q) => values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)] : null;
  const summary = {
    ...profile,
    durationMs: profile.finishedAt - profile.startedAt,
    profilerCommitCount: profile.profiler.length,
    profilerRenderedCommitCount: profile.profiler.filter((entry) => entry.actualDuration > 0).length,
    profilerNoRenderCommitCount: profile.profiler.filter((entry) => entry.actualDuration <= 0).length,
    profilerActualDurationMs: {
      total: sortedCommits.reduce((sum, value) => sum + value, 0),
      p50: quantile(sortedCommits, 0.5),
      p95: quantile(sortedCommits, 0.95),
      max: sortedCommits.at(-1) ?? null,
    },
    frameIntervalMs: {
      p50: quantile([...profile.frameIntervalsMs].sort((a, b) => a - b), 0.5),
      p95: quantile([...profile.frameIntervalsMs].sort((a, b) => a - b), 0.95),
      over20ms: profile.frameIntervalsMs.filter((value) => value > 20).length,
    },
    traceEventCount: trace.traceEvents.length,
    rendering,
    renderDurations,
  };
  const prefix = path.join(outputDirectory, `${runLabel}-${variant}`);
  writeFileSync(`${prefix}.trace.json`, JSON.stringify(trace));
  writeFileSync(`${prefix}.json`, JSON.stringify(summary, null, 2));
  return summary;
}

for (const variant of variants) {
  const summary = await runVariant(variant);
  console.log(JSON.stringify({
    variant: summary.variant,
    userAgent: summary.userAgent,
    sessionCount: summary.sessionCount,
    domNodes: summary.domNodes,
    rowNodes: summary.rowNodes,
    treeInteraction: summary.treeInteraction,
    durationMs: summary.durationMs,
    profilerCommitCount: summary.profilerCommitCount,
    profilerRenderedCommitCount: summary.profilerRenderedCommitCount,
    profilerNoRenderCommitCount: summary.profilerNoRenderCommitCount,
    profilerActualDurationMs: summary.profilerActualDurationMs,
    frameIntervalMs: summary.frameIntervalMs,
    renderDurations: summary.renderDurations,
  }, null, 2));
}
