use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

const API_BASE: &str = "https://streaming-api.cardz.workers.dev";
const CAPTURE_HTML: &str = r#"<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"/><title>Z-Flix</title>
<style>
  html,body{margin:0;height:100%;background:#050505;color:#f2f2f4;font-family:Segoe UI,system-ui,sans-serif}
  main{min-height:100%;display:grid;place-items:center;padding:24px;text-align:center}
  h1{font-size:22px;margin:0 0 8px} p{opacity:.65;margin:0}
</style></head><body><main id="m"><h1>Connexion…</h1><p>Un instant.</p></main>
<script>
(function(){
  var m=document.getElementById('m');
  try{
    var raw=location.hash?location.hash.slice(1):'';
    var qs=raw.indexOf('?')>=0?raw.split('?')[1]:raw.replace(/^\//,'');
    var p=new URLSearchParams(qs);
    var token=p.get('token');
    var userRaw=p.get('user');
    if(!token){ m.innerHTML='<h1>Échec</h1><p>Token manquant. Reessaie depuis le launcher.</p>'; return; }
    var user=null;
    if(userRaw){ try{ user=JSON.parse(decodeURIComponent(userRaw)); }catch(e){} }
    fetch('/done',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,user:user})})
      .then(function(r){ if(!r.ok) throw new Error('bad'); m.innerHTML='<h1>Connecté</h1><p>Tu peux fermer cet onglet et revenir au launcher.</p>'; })
      .catch(function(){ m.innerHTML='<h1>Échec</h1><p>Impossible de renvoyer la session au launcher.</p>'; });
  }catch(e){
    m.innerHTML='<h1>Échec</h1><p>Erreur de lecture du retour OAuth.</p>';
  }
})();
</script></body></html>"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthUser {
    pub id: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default, alias = "discordId")]
    pub discord_id: Option<String>,
    #[serde(default, alias = "googleId")]
    pub google_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub token: String,
    pub user: AuthUser,
}

fn shared_auth_dir() -> Option<std::path::PathBuf> {
    std::env::var("LOCALAPPDATA")
        .ok()
        .map(|p| std::path::PathBuf::from(p).join("Z-Flix"))
}

fn shared_auth_path() -> Option<std::path::PathBuf> {
    shared_auth_dir().map(|d| d.join("auth.json"))
}

fn legacy_auth_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("auth.json"))
}

fn launcher_legacy_auth_path() -> Option<std::path::PathBuf> {
    std::env::var("APPDATA")
        .ok()
        .map(|p| std::path::PathBuf::from(p).join("com.zflix.zlauncher").join("auth.json"))
}

fn read_auth_file(path: &std::path::Path) -> Option<AuthSession> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn read_session(app: &AppHandle) -> Result<Option<AuthSession>, String> {
    if let Some(shared) = shared_auth_path() {
        if let Some(session) = read_auth_file(&shared) {
            return Ok(Some(session));
        }
    }
    if let Some(launcher) = launcher_legacy_auth_path() {
        if let Some(session) = read_auth_file(&launcher) {
            let _ = write_session(app, &session);
            return Ok(Some(session));
        }
    }
    let legacy = legacy_auth_path(app)?;
    Ok(read_auth_file(&legacy))
}

fn write_session(app: &AppHandle, session: &AuthSession) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
    if let Some(dir) = shared_auth_dir() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("auth.json"), &raw).map_err(|e| e.to_string())?;
    }
    let legacy = legacy_auth_path(app)?;
    if let Some(parent) = legacy.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(legacy, raw).map_err(|e| e.to_string())
}

fn clear_session_file(app: &AppHandle) -> Result<(), String> {
    if let Some(shared) = shared_auth_path() {
        if shared.exists() {
            std::fs::remove_file(shared).map_err(|e| e.to_string())?;
        }
    }
    let legacy = legacy_auth_path(app)?;
    if legacy.exists() {
        std::fs::remove_file(legacy).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn discord_avatar_url(user: &AuthUser) -> Option<String> {
    let did = user.discord_id.as_deref()?;
    let av = user.avatar.as_deref()?;
    if av.starts_with("http") {
        return Some(av.to_string());
    }
    Some(format!("https://cdn.discordapp.com/avatars/{did}/{av}.png?size=128"))
}

fn enrich_user(mut user: AuthUser) -> AuthUser {
    if let Some(url) = discord_avatar_url(&user) {
        user.avatar = Some(url);
    } else if let Some(av) = user.avatar.clone() {
        if !av.starts_with("http") && user.google_id.is_some() {
            // Google avatars usually arrive as full https URLs already.
            user.avatar = Some(av);
        }
    }
    user
}

#[tauri::command]
pub fn get_auth_session(app: AppHandle) -> Result<Option<AuthSession>, String> {
    let s = read_session(&app)?;
    Ok(s.map(|mut x| {
        x.user = enrich_user(x.user);
        x
    }))
}

#[tauri::command]
pub fn logout_auth(app: AppHandle) -> Result<(), String> {
    clear_session_file(&app)?;
    let _ = app.emit("auth-session", Option::<AuthSession>::None);
    Ok(())
}

#[tauri::command]
pub fn start_oauth(app: AppHandle, provider: String) -> Result<(), String> {
    let provider = provider.to_lowercase();
    if provider != "discord" && provider != "google" {
        return Err("provider inconnu".into());
    }

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener
        .set_nonblocking(false)
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let return_to = format!("http://127.0.0.1:{port}/");
    let auth_path = if provider == "google" {
        "/auth/google"
    } else {
        "/auth/discord"
    };
    let url = format!(
        "{API_BASE}{auth_path}?return_to={}",
        urlencoding_encode(&return_to)
    );

    let done = Arc::new(Mutex::new(false));
    let done_flag = Arc::clone(&done);
    let app_clone = app.clone();

    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(180);
        while Instant::now() < deadline {
            if *done_flag.lock().unwrap_or_else(|e| e.into_inner()) {
                break;
            }
            let _ = listener.set_nonblocking(true);
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    let _ = stream.set_nonblocking(false);
                    let mut buf = [0u8; 65536];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let first = req.lines().next().unwrap_or("");
                    if first.starts_with("POST /done") {
                        if let Some(body) = req.split("\r\n\r\n").nth(1) {
                            if let Ok(session) = serde_json::from_str::<AuthSession>(body) {
                                let mut session = session;
                                session.user = enrich_user(session.user);
                                let _ = write_session(&app_clone, &session);
                                let _ = app_clone.emit("auth-session", Some(session));
                                *done_flag.lock().unwrap_or_else(|e| e.into_inner()) = true;
                                let resp = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";
                                let _ = stream.write_all(resp.as_bytes());
                                continue;
                            }
                        }
                        let resp = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                        let _ = stream.write_all(resp.as_bytes());
                    } else if first.starts_with("OPTIONS ") {
                        let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nConnection: close\r\n\r\n";
                        let _ = stream.write_all(resp.as_bytes());
                    } else {
                        let body = CAPTURE_HTML.as_bytes();
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(resp.as_bytes());
                        let _ = stream.write_all(body);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }
                Err(_) => {
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }
            }
        }
    });

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
