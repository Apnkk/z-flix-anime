mod auth;
mod http_fetch;
mod media_proxy;

use tauri::Manager;

#[cfg(windows)]
fn configure_windows_stream_capture() {
    // Discord/OBS capture audio by process — group sessions under Z-Animes, not WebView2 child.
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    let app_id: Vec<u16> = OsStr::new("com.zflix.animes")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    #[link(name = "shell32")]
    extern "system" {
        fn SetCurrentProcessExplicitAppUserModelID(app_id: *const u16) -> i32;
    }

    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr());
    }
}

#[cfg(not(windows))]
fn configure_windows_stream_capture() {}

/// Cinematic rectangle matching tauri.conf default 1600×840 (~1.90:1).
const WINDOW_ASPECT: f64 = 1600.0 / 840.0;
const WORK_MARGIN: f64 = 24.0;
const OCCUPY: f64 = 0.89;
const PREFERRED_MIN_W: f64 = 880.0;
const PREFERRED_MIN_H: f64 = 520.0;

struct FittedWindow {
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
}

/// Largest 1600:840 rect that fits in `box_w` × `box_h`. Never invents pixels.
fn fit_aspect(box_w: f64, box_h: f64) -> (f64, f64) {
    let box_w = box_w.max(1.0);
    let box_h = box_h.max(1.0);
    let w_from_h = box_h * WINDOW_ASPECT;
    if w_from_h <= box_w {
        (w_from_h, box_h)
    } else {
        (box_w, box_w / WINDOW_ASPECT)
    }
}

fn cinematic_fit(avail_w: f64, avail_h: f64) -> FittedWindow {
    let max_w = (avail_w - WORK_MARGIN).max(1.0);
    let max_h = (avail_h - WORK_MARGIN).max(1.0);
    let (width, height) = fit_aspect(max_w * OCCUPY, max_h * OCCUPY);
    // Preferred mins only when they still fit; never overflow a small work area.
    let min_width = PREFERRED_MIN_W.min(width).min(max_w);
    let min_height = PREFERRED_MIN_H.min(height).min(max_h);
    FittedWindow {
        width,
        height,
        min_width,
        min_height,
    }
}

fn work_area_logical(monitor: &tauri::Monitor) -> (f64, f64) {
    let scale = monitor.scale_factor().max(0.5);
    let area = monitor.work_area();
    (
        (area.size.width as f64 / scale).max(1.0),
        (area.size.height as f64 / scale).max(1.0),
    )
}

fn pick_monitor(window: &tauri::WebviewWindow) -> Option<tauri::Monitor> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| {
            window
                .available_monitors()
                .ok()
                .and_then(|list| list.into_iter().next())
        })
}

fn apply_window_fit(
    window: &tauri::WebviewWindow,
    force: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return Ok(());
    }
    let (avail_w, avail_h) = match pick_monitor(window) {
        Some(monitor) => work_area_logical(&monitor),
        None => (1920.0, 1080.0),
    };
    if !force {
        if let (Ok(physical), Ok(scale)) = (window.inner_size(), window.scale_factor()) {
            let scale = scale.max(0.5);
            let cur_w = physical.width as f64 / scale;
            let cur_h = physical.height as f64 / scale;
            // Leave a user-resized window alone unless it overflows this screen.
            if cur_w <= avail_w + 2.0 && cur_h <= avail_h + 2.0 {
                let fitted = cinematic_fit(avail_w, avail_h);
                let _ = window.set_min_size(Some(tauri::LogicalSize::new(
                    fitted.min_width,
                    fitted.min_height,
                )));
                return Ok(());
            }
        }
    }
    let fitted = cinematic_fit(avail_w, avail_h);
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(
        fitted.min_width,
        fitted.min_height,
    )));
    let _ = window.set_max_size(None::<tauri::LogicalSize<u32>>);
    window.set_size(tauri::LogicalSize::new(fitted.width, fitted.height))?;
    window.center()?;
    Ok(())
}

fn fit_main_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window missing")?;
    apply_window_fit(&window, true)?;
    let watcher = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
            let _ = apply_window_fit(&watcher, false);
        }
        _ => {}
    });
    Ok(())
}

#[cfg(test)]
mod window_fit_tests {
    use super::*;

    fn almost_eq(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "{a} vs {b} (tol {tol})");
    }

    fn assert_aspect_and_fits(avail_w: f64, avail_h: f64) -> FittedWindow {
        let fitted = cinematic_fit(avail_w, avail_h);
        almost_eq(fitted.width / fitted.height, WINDOW_ASPECT, 0.02);
        assert!(
            fitted.width + WORK_MARGIN <= avail_w + 0.5,
            "width overflow {} in {}",
            fitted.width,
            avail_w
        );
        assert!(
            fitted.height + WORK_MARGIN <= avail_h + 0.5,
            "height overflow {} in {}",
            fitted.height,
            avail_h
        );
        assert!(fitted.min_width <= fitted.width);
        assert!(fitted.min_height <= fitted.height);
        fitted
    }

    #[test]
    fn fit_1080p_matches_user_size() {
        // 1920×1080 minus ~40px taskbar. ~89% occupy → ~1688×886.
        let fitted = assert_aspect_and_fits(1920.0, 1040.0);
        almost_eq(fitted.width, 1688.0, 10.0);
        almost_eq(fitted.height, 886.0, 10.0);
        almost_eq(fitted.min_width, PREFERRED_MIN_W, 0.1);
    }

    #[test]
    fn fit_1440p_scales_up() {
        let fitted = assert_aspect_and_fits(2560.0, 1400.0);
        assert!(fitted.width > 2000.0);
        assert!(fitted.width < 2560.0);
    }

    #[test]
    fn fit_laptop_1366() {
        let fitted = assert_aspect_and_fits(1366.0, 728.0);
        assert!(fitted.width >= 1100.0);
        assert!(fitted.height < 728.0);
    }

    #[test]
    fn fit_hidpi_laptop_does_not_overflow() {
        // 1366×768 @ 150% → ~911×512 logical, taskbar ~40px.
        let fitted = assert_aspect_and_fits(911.0, 472.0);
        assert!(fitted.width < 911.0);
        assert!(fitted.height < 472.0);
        assert!(fitted.min_height <= fitted.height);
    }

    #[test]
    fn fit_ultrawide_keeps_cinematic_not_full_width() {
        let fitted = assert_aspect_and_fits(3440.0, 1400.0);
        assert!(
            fitted.width < 3000.0,
            "ultrawide must not stretch full width, got {}",
            fitted.width
        );
        almost_eq(fitted.width / fitted.height, WINDOW_ASPECT, 0.02);
    }

    #[test]
    fn fit_4k_100pct_fills_not_tiny() {
        let fitted = assert_aspect_and_fits(3840.0, 2120.0);
        assert!(fitted.width > 3000.0);
    }

    #[test]
    fn fit_4k_200pct_same_as_1080p() {
        // 3840×2160 @ 200% → 1920×1080 logical.
        let a = cinematic_fit(1920.0, 1040.0);
        let b = cinematic_fit(3840.0 / 2.0, 2080.0 / 2.0);
        almost_eq(a.width, b.width, 1.0);
        almost_eq(a.height, b.height, 1.0);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            configure_windows_stream_capture();
            fit_main_window(app).ok();
            let _ = media_proxy::ensure_media_proxy();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth::get_auth_session,
            auth::logout_auth,
            auth::start_oauth,
            http_fetch::fetch_text,
            http_fetch::fetch_text_insecure,
            http_fetch::fetch_post_form,
            media_proxy::start_media_proxy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running z-animes");
}
