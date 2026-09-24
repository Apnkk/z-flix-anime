import re

with open('src-tauri/src/media_proxy.rs', 'r', encoding='utf-8') as f:
    content = f.read()

injection = """
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
                
                if trimmed.starts_with("#EXT-X-MEDIA:") && trimmed.contains("URI=\\"") {
                    if let Some(uri_start) = line.find("URI=\\"") {
                        let after_uri = &line[uri_start + 5..];
                        if let Some(uri_end) = after_uri.find('"') {
                            let uri = &after_uri[..uri_end];
                            if let Ok(resolved) = target.join(uri) {
                                let enc_url = urlencoding::encode(resolved.as_str());
                                let enc_ref = urlencoding::encode(&referer);
                                let proxied = format!("http://{}/?url={}&referer={}", proxy_host, enc_url, enc_ref);
                                let new_line = format!("{}URI=\\"{}\\"{}", &line[..uri_start], proxied, &after_uri[uri_end + 1..]);
                                new_m3u8.push_str(&new_line);
                                new_m3u8.push('\\n');
                                continue;
                            }
                        }
                    }
                }

                if trimmed.starts_with('#') {
                    new_m3u8.push_str(line);
                    new_m3u8.push('\\n');
                } else {
                    if let Ok(resolved) = target.join(trimmed) {
                        let enc_url = urlencoding::encode(resolved.as_str());
                        let enc_ref = urlencoding::encode(&referer);
                        let proxied = format!("http://{}/?url={}&referer={}", proxy_host, enc_url, enc_ref);
                        new_m3u8.push_str(&proxied);
                        new_m3u8.push('\\n');
                    } else {
                        new_m3u8.push_str(line);
                        new_m3u8.push('\\n');
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
"""

new_content = content.replace(
    'let reader: Box<dyn Read + Send> = Box::new(res);',
    injection + '\n    let reader: Box<dyn Read + Send> = Box::new(res);'
)

if injection in content:
    print("Already patched.")
elif new_content == content:
    print("Could not find insertion point!")
else:
    with open('src-tauri/src/media_proxy.rs', 'w', encoding='utf-8') as f:
        f.write(new_content)
    print("Patched successfully!")
