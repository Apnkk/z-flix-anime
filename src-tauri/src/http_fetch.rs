use serde::Serialize;
use tauri::command;

#[derive(Debug, Serialize)]
pub struct FetchTextError {
    pub message: String,
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(14))
        .redirect(reqwest::redirect::Policy::limited(6))
        .build()
        .map_err(|e| e.to_string())
}

fn build_insecure_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(14))
        .redirect(reqwest::redirect::Policy::limited(6))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())
}

fn allow_insecure_host(url: &url::Url) -> Result<(), String> {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if host == "landflix.fr" || host == "www.landflix.fr" {
        return Ok(());
    }
    Err("fetch insecure: host non autorise".into())
}

fn validate_url(url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("url invalide: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("protocole non supporté".into());
    }
    Ok(parsed)
}

fn cap_text(text: String) -> String {
    if text.len() > 2_000_000 {
        text.chars().take(2_000_000).collect()
    } else {
        text
    }
}

/// Fetch remote HTML/text from the desktop IP (bypasses WebView CORS).
/// Needed for Sibnet/Sendvid: Cloudflare Worker IPs get 403 on those hosters.
#[command]
pub async fn fetch_text(url: String, referer: Option<String>) -> Result<String, String> {
    let parsed = validate_url(&url)?;
    let client = build_client()?;

    let mut req = client
        .get(parsed)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
        )
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "fr-FR,fr;q=0.9,en;q=0.8");

    if let Some(r) = referer.as_deref() {
        if r.starts_with("http://") || r.starts_with("https://") {
            req = req.header("Referer", r);
        }
    }

    let res = req.send().await.map_err(|e| format!("fetch: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let text = res.text().await.map_err(|e| format!("body: {e}"))?;
    Ok(cap_text(text))
}

/// POST application/x-www-form-urlencoded (DooPlay ajax players, etc.).
#[command]
pub async fn fetch_post_form(
    url: String,
    body: String,
    referer: Option<String>,
) -> Result<String, String> {
    let parsed = validate_url(&url)?;
    let client = build_client()?;

    let mut req = client
        .post(parsed)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
        )
        .header("Accept", "application/json,text/plain,*/*")
        .header("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Accept-Language", "fr-FR,fr;q=0.9,en;q=0.8")
        .body(body);

    if let Some(r) = referer.as_deref() {
        if r.starts_with("http://") || r.starts_with("https://") {
            req = req.header("Referer", r);
            if let Ok(u) = url::Url::parse(r) {
                req = req.header("Origin", u.origin().ascii_serialization());
            }
        }
    }

    let res = req.send().await.map_err(|e| format!("fetch: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let text = res.text().await.map_err(|e| format!("body: {e}"))?;
    Ok(cap_text(text))
}

/// Landflix only — invalid TLS on landflix.fr blocks normal fetch.
#[command]
pub async fn fetch_text_insecure(url: String, referer: Option<String>) -> Result<String, String> {
    let parsed = validate_url(&url)?;
    allow_insecure_host(&parsed)?;
    let client = build_insecure_client()?;

    let mut req = client
        .get(parsed)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
        )
        .header("Accept", "text/html,application/xhtml+xml,application/json,*/*;q=0.8")
        .header("Accept-Language", "fr-FR,fr;q=0.9,en;q=0.8");

    if let Some(r) = referer.as_deref() {
        if r.starts_with("http://") || r.starts_with("https://") {
            req = req.header("Referer", r);
        }
    }

    let res = req.send().await.map_err(|e| format!("fetch: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let text = res.text().await.map_err(|e| format!("body: {e}"))?;
    Ok(cap_text(text))
}
