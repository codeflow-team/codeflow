/**
 * The key box for the hosted build — bring your own.
 *
 * There is no server here to hold a key, and a shared one baked into a
 * serverless function is a key anyone can drain, so the honest arrangement is
 * that the visitor supplies theirs. The copy says exactly where it goes,
 * because "paste your API key" with no explanation is a thing a reader is right
 * to refuse: it is stored in this browser's `localStorage`, and the request
 * goes from this page straight to `openrouter.ai` — the origin serving this
 * page never sees it and could not use it if it did.
 *
 * Everything else in the demo — analyze, graph, inspect, patch, diff — needs no
 * key at all, which is why this is a small box in one panel and not a wall in
 * front of the app. It lives on its own file because the create dialog needs the
 * same box for the same reason: without a key it must still work for "start
 * blank", and it must say plainly what a key would buy.
 */

import { useState, type ReactNode } from "react";
import { Button, Input, Notice } from "@codeflow/react";
import { clearUserKey, getUserKey, setUserKey } from "./ai.js";
import { REPO_URL } from "./deployment.js";

export function ByokKeyBox(props: {
  configured: boolean;
  model: string;
  onChanged?: () => void;
}): ReactNode {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(!props.configured);

  if (props.configured && !editing) {
    const key = getUserKey() ?? "";
    return (
      <Notice tone="ok" title="Using your OpenRouter key">
        <p className="m-0">
          <code className="font-mono text-[11px]">{key.slice(0, 8)}…{key.slice(-4)}</code> — stored
          in this browser only, sent straight to openrouter.ai. Model:{" "}
          <code className="font-mono text-[11px]">{props.model}</code>.
        </p>
        <div className="mt-2 flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => { setDraft(""); setEditing(true); }}>
            Replace
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearUserKey();
              setEditing(true);
              props.onChanged?.();
            }}
          >
            Forget it
          </Button>
        </div>
      </Notice>
    );
  }

  return (
    <Notice tone="info" title="Ask AI needs a key — yours">
      <p className="m-0">
        This is the hosted demo: it is a static site with no server, so there is no key here to
        borrow. Paste an <a className="underline" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">OpenRouter key</a>{" "}
        and it is kept in this browser&apos;s local storage and sent only to{" "}
        <code className="font-mono text-[11px]">openrouter.ai</code> — never to the site serving this
        page. <code className="font-mono text-[11px]">{props.model}</code> is free there.
      </p>
      <p className="m-0 mt-1.5 text-ink-faint">
        Everything else — the graph, the inspector, editing, the diff — works without any key.
      </p>
      <div className="mt-2 flex gap-2">
        <Input
          mono
          type="password"
          value={draft}
          placeholder="sk-or-v1-…"
          aria-label="Your OpenRouter API key"
          data-testid="byok-input"
          className="min-w-0 flex-1"
          onChange={(event) => { setDraft(event.target.value); }}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={draft.trim().length < 12}
          data-testid="byok-save"
          onClick={() => {
            setUserKey(draft);
            setDraft("");
            setEditing(false);
            props.onChanged?.();
          }}
        >
          Use it
        </Button>
      </div>
      <p className="m-0 mt-2 text-[11px] text-ink-faint">
        Prefer not to? Run it locally instead — <code className="font-mono text-[11px]">git clone {REPO_URL}</code>,{" "}
        <code className="font-mono text-[11px]">pnpm dev</code>, and the key stays in the dev server.
      </p>
    </Notice>
  );
}
