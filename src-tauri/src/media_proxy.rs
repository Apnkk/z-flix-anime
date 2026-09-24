//! Local loopback proxy: play Sibnet/Sendvid/SprintCDN/Vidzy MP4 & HLS from the desktop IP
//! with the hoster Referer. Bypasses Cloudflare Worker egress blocks and French ISP DNS poisoning.

use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use tauri::command;
use tiny_http::{Header, Method, Response, Server, StatusCode};
use url::Url;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0";

static PORT: OnceLock<u16> = OnceLock::new();
static DOH_IPS: OnceLock<RwLock<HashMap<String, IpAddr>>> = OnceLock::new();
static CLIENT_CACHE: OnceLock<RwLock<HashMap<String, reqwest::blocking::Client>>> = OnceLock::new();

#[derive(serde::Deserialize)]
struct DohAnswer {
    #[serde(rename = "type")]
    rtype: u16,
    data: String,
}

#[derive(serde::Deserialize)]
struct DohResponse {
    #[serde(rename = "Answer")]
    answer: Option<Vec<DohAnswer>>,
}

fn doh_cache() -> &'static RwLock<HashMap<String, IpAddr>> {
    DOH_IPS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn client_cache() -> &'static RwLock<HashMap<String, reqwest::blocking::Client>> {
    CLIENT_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn host_allowed(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    let allowed_patterns = [
        "sibnet.ru",
        "sendvid.com",
        "streamtape.com",
        "streamta.pe",
        "finepulfe.xyz",
        "senpai-stream.club",
        "senpai-stream.site",
        "bysebuho.com",
        "r66nv9ed.com",
        "sprintcdn",
        "vidzy.org",
        "vidzy.live",
        "vidzy.cc",
        "vidmoly.to",
        "vidmoly.org",
        "vidmoly.net",
        "ansembed.net",
        "voe.sx",
        "voe-network.net",
        "doodstream.com",
        "dood.to",
        "dood.so",
        "dood.cx",
        "dood.la",
        "dood.ws",
        "dood.sh",
        "doods.pro",
        "filemoon.sx",
        "filemoon.to",
        "filemoon.in",
        "mp4upload.com",
        "streamwish.to",
        "streamwish.com",
        "strwish.com",
        "lulustream.com",
        "luluvdo.com",
        "streamhide.to",
        "streamhide.com",
    ];
    for p in allowed_patterns {
        if h == p || h.ends_with(&format!(".{p}")) || h.contains(p) {
            return true;
        }
    }
    false
}

fn default_referer(url: &Url) -> String {
    let h = url.host_str().unwrap_or("").to_ascii_lowercase();
    if h.contains("sibnet.ru") {
        "https://video.sibnet.ru/".into()
    } else if h.contains("sendvid") {
        "https://sendvid.com/".into()
    } else if h.contains("bysebuho") || h.contains("r66nv9ed") || h.contains("sprintcdn") {
        "https://bysebuho.com/".into()
    } else if h.contains("senpai") || h.contains("finepulfe") {
        "https://senpai-stream.site/".into()
    } else if h.contains("vidzy") {
        "https://vidzy.org/".into()
    } else if h.contains("vidmoly") {
        "https://vidmoly.to/".into()
    } else if h.contains("voe") {
        "https://voe.sx/".into()
    } else if h.contains("streamtape") || h.contains("streamta.pe") {
        "https://streamtape.com/".into()
    } else {
        format!("{}://{}/", url.scheme(), url.host_str().unwrap_or("localhost"))
    }
}

fn resolve_location(base: &Url, loc: &str) -> Result<Url, String> {
    let loc = loc.trim();
    if loc.starts_with("//") {
        return Url::parse(&format!("{}:{loc}", base.scheme())).map_err(|e| e.to_string());
    }
    base.join(loc).map_err(|e| e.to_string())
}

fn header_bytes(name: &str, value: &str) -> Option<Header> {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).ok()
}

fn parse_target(url_raw: &str) -> Result<(Url, String), String> {
    let full = if url_raw.starts_with("http://") {
        url_raw.to_string()
    } else {
        format!("http://127.0.0.1{url_raw}")
    };
    let req = Url::parse(&full).map_err(|e| e.to_string())?;
    let raw = req
        .query_pairs()
        .find(|(k, _)| k == "url")
        .map(|(_, v)| v.into_owned())
        .ok_or_else(|| "url manquante".to_string())?;
    let target = Url::parse(&raw).map_err(|e| format!("url invalide: {e}"))?;
    if target.scheme() != "http" && target.scheme() != "https" {
        return Err("protocole non supporté".into());
    }
    let host = target.host_str().unwrap_or("");
    if !host_allowed(host) {
        return Err(format!("hôte non autorisé: {host}"));
    }
    let referer = req
        .query_pairs()
        .find(|(k, _)| k == "referer")
        .map(|(_, v)| v.into_owned())
        .filter(|r| r.starts_with("http://") || r.starts_with("https://"))
        .unwrap_or_else(|| default_referer(&target));
    Ok((target, referer))
}

fn text_response(code: u16, body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut res = Response::from_string(body.to_string()).with_status_code(StatusCode(code));
    if let Some(h) = header_bytes("Access-Control-Allow-Origin", "*") {
        res.add_header(h);
    }
    if let Some(h) = header_bytes("Connection", "close") {
        res.add_header(h);
    }
    res
}
static DOH_CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

fn doh_http_client() -> &'static reqwest::blocking::Client {
    DOH_CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(4))
            .build()
            .unwrap_or_default()
    })
}

fn resolve_doh(host: &str) -> Option<IpAddr> {
    if let Ok(guard) = doh_cache().read() {
        if let Some(ip) = guard.get(host) {
            return Some(*ip);
        }
    }

    // Direct connection to 1.1.1.1 (no DNS needed)
    let url = format!("https://1.1.1.1/dns-query?name={host}&type=A");
    let c = doh_http_client();

    let res = c
        .get(&url)
        .header("accept", "application/dns-json")
        .send()
        .ok()?;

    let data: DohResponse = res.json().ok()?;
    if let Some(answers) = data.answer {
        for a in answers {
            if a.rtype == 1 {
                if let Ok(ip) = a.data.trim().parse::<IpAddr>() {
                    if !ip.is_loopback() {
                        if let Ok(mut guard) = doh_cache().write() {
                            guard.insert(host.to_string(), ip);
                        }
                        return Some(ip);
                    }
                }
            }
        }
    }
    None
}

fn is_poisoned_or_loopback(host: &str) -> bool {
    let target = format!("{host}:443");
    if let Ok(addrs) = target.to_socket_addrs() {
        let list: Vec<_> = addrs.collect();
        if list.is_empty() || list.iter().all(|a| a.ip().is_loopback()) {
            return true;
        }
        false
    } else {
        true
    }
}

fn should_use_doh(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    if h.contains("sibnet.ru")
        || h.contains("sendvid.com")
        || h.contains("bysebuho.com")
        || h.contains("r66nv9ed.com")
        || h.contains("sprintcdn")
        || h.contains("ansembed")
        || h.contains("vidzy")
        || h.contains("senpai")
        || h.contains("finepulfe")
    {
        return true;
    }
    is_poisoned_or_loopback(&h)
}

fn get_client_for_target(target: &Url, default_client: &reqwest::blocking::Client) -> reqwest::blocking::Client {
    let host = match target.host_str() {
        Some(h) => h.to_ascii_lowercase(),
        None => return default_client.clone(),
    };
    let port = target.port_or_known_default().unwrap_or(443);
    let cache_key = format!("{host}:{port}");

    if let Ok(guard) = client_cache().read() {
        if let Some(c) = guard.get(&cache_key) {
            return c.clone();
        }
    }

    if should_use_doh(&host) {
        if let Some(ip) = resolve_doh(&host) {
            let socket_addr = SocketAddr::new(ip, port);
            let client_res = reqwest::blocking::Client::builder()
                .resolve(&host, socket_addr)
                .connect_timeout(Duration::from_secs(20))
                .timeout(None)
                .redirect(reqwest::redirect::Policy::none())
                .build();
            if let Ok(c) = client_res {
                if let Ok(mut guard) = client_cache().write() {
                    guard.insert(cache_key, c.clone());
                }
                return c;
            }
        }
    }

    default_client.clone()
}

fn handle_one(request: tiny_http::Request, client: &reqwest::blocking::Client) {
    if request.method() == &Method::Options {
        let mut res = Response::empty(204);
        for (n, v) in [
            ("Access-Control-Allow-Origin", "*"),
            ("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"),
            ("Access-Control-Allow-Headers", "Range, Content-Type"),
            ("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges"),
            ("Connection", "close"),
        ] {
            if let Some(h) = header_bytes(n, v) {
                res.add_header(h);
            }
        }
        let _ = request.respond(res);
        return;
    }

    let is_head = request.method() == &Method::Head;
    let mut range = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    // Hosters like Sibnet return 400 to HEAD requests. Transform HEAD into GET Range: bytes=0-0
    // so we can reliably fetch media metadata and total content length without downloading the file.
    if is_head && range.is_none() {
        range = Some("bytes=0-0".to_string());
    }

    let url_raw = request.url().to_string();
    let (mut target, referer) = match parse_target(&url_raw) {
        Ok(v) => v,
        Err(e) => {
            let _ = request.respond(text_response(400, &e));
            return;
        }
    };

    let origin = Url::parse(&referer)
        .ok()
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_else(|| default_referer(&target));

    // Always use GET upstream so video hosters that reject HEAD (Sibnet, etc.) succeed.
    let method = reqwest::Method::GET;

    let mut final_res: Option<reqwest::blocking::Response> = None;
    for _ in 0..6 {
        let active_client = get_client_for_target(&target, client);
        let mut req = active_client
            .request(method.clone(), target.clone())
            .header("User-Agent", UA)
            .header("Accept", "*/*")
            .header("Accept-Language", "fr-FR,fr;q=0.9,en;q=0.8")
            .header("Referer", &referer)
            .header("Origin", &origin);
        if let Some(r) = range.as_deref() {
            req = req.header("Range", r);
        }
        let res = match req.send() {
            Ok(r) => r,
            Err(e) => {
                let _ = request.respond(text_response(502, &format!("fetch: {e}")));
                return;
            }
        };
        if res.status().is_redirection() {
            let loc = res
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            match loc {
                Some(loc) => match resolve_location(&target, &loc) {
                    Ok(next) => {
                        if let Some(h) = next.host_str() {
                            if !host_allowed(h) {
                                let _ = request.respond(text_response(502, "redirect refusé"));
                                return;
                            }
                        }
                        target = next;
                        continue;
                    }
                    Err(e) => {
                        let _ = request.respond(text_response(502, &e));
                        return;
                    }
                },
                None => {
                    let _ = request.respond(text_response(502, "redirect sans Location"));
                    return;
                }
            }
        }
        final_res = Some(res);
        break;
    }

    let res = match final_res {
        Some(r) => r,
        None => {
            let _ = request.respond(text_response(502, "trop de redirects"));
            return;
        }
    };

    let status = res.status().as_u16();
    let headers_in = res.headers().clone();
    let len = res.content_length().map(|n| n as usize);

    let mut out_headers: Vec<Header> = Vec::new();
    // Do NOT pass "content-length" here: tiny_http automatically adds Content-Length
    // from data_length in Identity mode. Passing it manually would create duplicate
    // Content-Length headers, which Chromium rejects with net::ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_LENGTH.
    let pass = [
        "content-type",
        "content-range",
        "accept-ranges",
        "cache-control",
        "last-modified",
        "etag",
    ];
    for (k, v) in headers_in.iter() {
        let name = k.as_str();
        if pass.iter().any(|p| name.eq_ignore_ascii_case(p)) {
            if let Ok(val) = v.to_str() {
                if let Some(h) = header_bytes(name, val) {
                    out_headers.push(h);
                }
            }
        }
    }
    if !out_headers.iter().any(|h| h.field.equiv("Accept-Ranges")) {
        if let Some(h) = header_bytes("Accept-Ranges", "bytes") {
            out_headers.push(h);
        }
    }
    if let Some(h) = header_bytes("Access-Control-Allow-Origin", "*") {
        out_headers.push(h);
    }
    if let Some(h) = header_bytes(
        "Access-Control-Expose-Headers",
        "Content-Length, Content-Range, Accept-Ranges",
    ) {
        out_headers.push(h);
    }
    if let Some(h) = header_bytes("Connection", "close") {
        out_headers.push(h);
    }

    if is_head {
        let empty: &[u8] = &[];
        // Extract total file size from "bytes 0-0/441092065" if present
        let total_len = headers_in
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|cr| cr.rsplit('/').next())
            .and_then(|s| s.parse::<usize>().ok())
            .or(len);
        let head_status = if request.headers().iter().any(|h| h.field.equiv("Range")) {
            status
        } else {
            200
        };
        let resp = Response::new(StatusCode(head_status), out_headers, empty, total_len, None)
            .with_chunked_threshold(usize::MAX);
        let _ = request.respond(resp);
        return;
    }

    
    let is_m3u8 = target.path().ends_with(".m3u8") || 
        out_headers.iter().any(|h| h.field.equiv("content-type") && h.value.as_str().contains("mpegurl"));
    
    if is_m3u8 {
        use std::io::Read;
        let mut text = String::new();
        let mut mut_res = res;
        if let Ok(_) = mut_res.read_to_string(&mut text) {
            let proxy_host = request.headers().iter()
                .find(|h| h.field.equiv("host"))
                .map(|h| h.value.as_str())
                .unwrap_or("127.0.0.1:0");
            
            let mut new_m3u8 = String::with_capacity(text.len() * 2);
            for line in text.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                
                if trimmed.starts_with("#EXT-X-MEDIA:") && trimmed.contains("URI=\"") {
                    if let Some(uri_start) = line.find("URI=\"") {
                        let after_uri = &line[uri_start + 5..];
                        if let Some(uri_end) = after_uri.find('"') {
                            let uri = &after_uri[..uri_end];
                            if let Ok(resolved) = target.join(uri) {
                                let enc_url = urlencoding::encode(resolved.as_str());
                                let enc_ref = urlencoding::encode(&referer);
                                let proxied = format!("http://{}/?url={}&referer={}", proxy_host, enc_url, enc_ref);
                                let new_line = format!("{}URI=\"{}\"{}", &line[..uri_start], proxied, &after_uri[uri_end + 1..]);
                                new_m3u8.push_str(&new_line);
                                new_m3u8.push('\n');
                                continue;
                            }
                        }
                    }
                }

                if trimmed.starts_with('#') {
                    new_m3u8.push_str(line);
                    new_m3u8.push('\n');
                } else {
                    if let Ok(resolved) = target.join(trimmed) {
                        let enc_url = urlencoding::encode(resolved.as_str());
                        let enc_ref = urlencoding::encode(&referer);
                        let proxied = format!("http://{}/?url={}&referer={}", proxy_host, enc_url, enc_ref);
                        new_m3u8.push_str(&proxied);
                        new_m3u8.push('\n');
                    } else {
                        new_m3u8.push_str(line);
                        new_m3u8.push('\n');
                    }
                }
            }
            
            let bytes = new_m3u8.into_bytes();
            let new_len = bytes.len();
            let reader: Box<dyn std::io::Read + Send> = Box::new(std::io::Cursor::new(bytes));
            
            out_headers.retain(|h| !h.field.equiv("content-length"));
            
            let resp = Response::new(StatusCode(status), out_headers, reader, Some(new_len), None)
                .with_chunked_threshold(usize::MAX);
            let _ = request.respond(resp);
            return;
        } else {
            let _ = request.respond(text_response(502, "Erreur lecture m3u8"));
            return;
        }
    }

    let reader: Box<dyn Read + Send> = Box::new(res);
    // with_chunked_threshold(usize::MAX) forces tiny_http to keep Identity transfer encoding
    // instead of switching to Chunked encoding (>32KB), which would break media range streaming in WebView2.
    let resp = Response::new(StatusCode(status), out_headers, reader, len, None)
        .with_chunked_threshold(usize::MAX);
    let _ = request.respond(resp);
}

/// Bind 127.0.0.1 once (sync, from Tauri setup).
pub fn ensure_media_proxy() -> Result<u16, String> {
    if let Some(p) = PORT.get() {
        return Ok(*p);
    }
    let server = Server::http("127.0.0.1:0").map_err(|e| format!("bind proxy: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| "proxy addr".to_string())?;

    std::thread::Builder::new()
        .name("zflix-media-proxy".into())
        .spawn(move || {
            let client = match reqwest::blocking::Client::builder()
                .connect_timeout(Duration::from_secs(20))
                .timeout(None)
                .redirect(reqwest::redirect::Policy::none())
                .build()
            {
                Ok(c) => c,
                Err(_) => return,
            };
            for request in server.incoming_requests() {
                let c = client.clone();
                std::thread::spawn(move || handle_one(request, &c));
            }
        })
        .map_err(|e| format!("thread proxy: {e}"))?;

    let _ = PORT.set(port);
    Ok(port)
}

#[command]
pub fn start_media_proxy() -> Result<u16, String> {
    ensure_media_proxy()
}
