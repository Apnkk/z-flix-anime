import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import {
  setClientFetchPostForm,
  setClientFetchText,
  setClientFetchTextInsecure,
  setMediaProxyBase,
  setResolveAuthToken,
  loadSession,
} from "@zflix/desktop-core";
import App from "./App";
import "./App.css";

const fetchText = async (url: string, referer?: string) => {
  try {
    const text = await invoke<string>("fetch_text", { url, referer: referer ?? null });
    return text || null;
  } catch {
    return null;
  }
};

const fetchPostForm = async (url: string, body: string, referer?: string) => {
  try {
    const text = await invoke<string>("fetch_post_form", {
      url,
      body,
      referer: referer ?? null,
    });
    return text || null;
  } catch {
    return null;
  }
};

const fetchTextInsecure = async (url: string, referer?: string) => {
  try {
    const text = await invoke<string>("fetch_text_insecure", { url, referer: referer ?? null });
    return text || null;
  } catch {
    return null;
  }
};

setClientFetchText(fetchText);
setClientFetchPostForm(fetchPostForm);
setClientFetchTextInsecure(fetchTextInsecure);
setResolveAuthToken(loadSession()?.token);

document.addEventListener("contextmenu", (e) => e.preventDefault());

async function boot() {
  try {
    const port = await invoke<number>("start_media_proxy");
    if (port > 0) setMediaProxyBase(`http://127.0.0.1:${port}`);
  } catch {
    /* play without local proxy — scrapers that need it will fail over */
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
