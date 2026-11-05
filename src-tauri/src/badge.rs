//! Tray badge: a rounded chip holding a pulse glyph and today's token count.
//!
//! macOS renders the badge as a template image that AppKit inverts for the
//! current menu bar. Linux panels have no such convention, so the badge ships
//! its own background colour to stay legible on both light and dark panels.

use std::path::PathBuf;
use std::sync::OnceLock;

use ab_glyph::{Font, FontRef, PxScale, ScaleFont};

/// Accent green, identical to the macOS accent (0.176, 0.541, 0.431).
const CHIP_RGB: [u8; 3] = [45, 138, 110];
const TEXT_RGB: [u8; 3] = [255, 255, 255];

/// Logical badge height. The panel scales this pixmap down to its own icon
/// size, so everything is rendered at twice the logical size to stay crisp on
/// HiDPI panels.
const LOGICAL_HEIGHT: f32 = 22.0;
const RENDER_SCALE: f32 = 2.0;

pub fn format_tokens(tokens: u64) -> String {
    if tokens >= 999_950_000 {
        return format!(
            "{}B",
            trim_trailing_zero(&format!("{:.1}", tokens as f64 / 1_000_000_000.0))
        );
    }
    if tokens >= 1_000_000 {
        return format!("{:.1}M", tokens as f64 / 1_000_000.0);
    }
    if tokens >= 1_000 {
        return format!("{:.1}K", tokens as f64 / 1_000.0);
    }
    tokens.to_string()
}

pub fn format_cost(cost: f64) -> String {
    let value = cost.abs();
    if value < 0.05 {
        return "$0".to_string();
    }
    if value < 10.0 {
        return format!("${cost:.2}");
    }
    if value < 100.0 {
        return format!("${cost:.1}");
    }
    format!("${cost:.0}")
}

/// Tray menu summary line, e.g. `今日 1.2M · $3.45`.
pub fn summary_label(tokens: Option<u64>, cost: Option<f64>) -> String {
    match (tokens, cost) {
        (Some(tokens), Some(cost)) => {
            format!("Today {} · {}", format_tokens(tokens), format_cost(cost))
        }
        (Some(tokens), None) => format!("Today {}", format_tokens(tokens)),
        _ => "Today --".to_string(),
    }
}

fn trim_trailing_zero(value: &str) -> String {
    let Some((head, fraction)) = value.split_once('.') else {
        return value.to_string();
    };
    let trimmed = fraction.trim_end_matches('0');
    if trimmed.is_empty() {
        head.to_string()
    } else {
        format!("{head}.{trimmed}")
    }
}

/// Font candidates, most preferred first. Finding no font only degrades the
/// badge to its pulse glyph; the number stays visible in the tray menu.
fn font_candidates() -> Vec<PathBuf> {
    if let Some(custom) = std::env::var_os("TOKENDASH_BADGE_FONT") {
        return vec![PathBuf::from(custom)];
    }
    #[cfg(windows)]
    {
        std::env::var_os("WINDIR")
            .map(PathBuf::from)
            .map(|base| {
                vec![
                    base.join("Fonts/consolab.ttf"),
                    base.join("Fonts/segoeuib.ttf"),
                ]
            })
            .unwrap_or_default()
    }
    #[cfg(not(windows))]
    [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
        "/usr/share/fonts/truetype/noto/NotoSansMono-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
        "/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf",
        "/usr/share/fonts/truetype/freefont/FreeMonoBold.ttf",
        "/System/Library/Fonts/Menlo.ttc",
    ]
    .iter()
    .map(PathBuf::from)
    .collect()
}

/// Font bytes are read once per process and kept for its lifetime: the badge is
/// re-rendered on every refresh, so re-reading and re-leaking them would grow
/// memory without bound.
fn font_bytes() -> Option<&'static [u8]> {
    static BYTES: OnceLock<Option<&'static [u8]>> = OnceLock::new();
    *BYTES.get_or_init(|| {
        for path in font_candidates() {
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let leaked: &'static [u8] = Box::leak(bytes.into_boxed_slice());
            if FontRef::try_from_slice(leaked).is_ok() {
                return Some(leaked);
            }
        }
        None
    })
}

fn load_font() -> Option<FontRef<'static>> {
    font_bytes().and_then(|bytes| FontRef::try_from_slice(bytes).ok())
}

/// RGBA pixmap plus its pixel dimensions, ready to hand to the tray.
pub struct RgbaImage {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Renders the badge for `tokens`. Only a degenerate canvas returns `None`.
pub fn render_badge(tokens: Option<u64>) -> Option<RgbaImage> {
    let height = LOGICAL_HEIGHT * RENDER_SCALE;
    let font_size = 12.5 * RENDER_SCALE;
    let pad_left = 5.5 * RENDER_SCALE;
    let glyph_width = 11.0 * RENDER_SCALE;
    let gap = 4.5 * RENDER_SCALE;
    let pad_right = 7.0 * RENDER_SCALE;
    let font = load_font();
    // Windows fixes notification-area icons to a square. Keep the glyph
    // readable and expose the full number in the tooltip and menu.
    let label = if cfg!(windows) {
        None
    } else {
        tokens.map(format_tokens)
    };

    let text_width = match (&font, &label) {
        (Some(font), Some(label)) => measure(font, font_size, label),
        _ => 0.0,
    };

    let width = if cfg!(windows) {
        height
    } else if font.is_some() && label.is_some() {
        pad_left + glyph_width + gap + text_width + pad_right
    } else if font.is_some() {
        // No data yet: keep the chip minimal so the panel does not jump around.
        pad_left + glyph_width + pad_right
    } else {
        height
    };

    let canvas_width = width.ceil() as u32;
    let canvas_height = height.ceil() as u32;
    let mut canvas = Canvas::new(canvas_width, canvas_height);
    canvas.fill_rounded_rect(
        [0.0, 0.0, canvas_width as f32, canvas_height as f32],
        6.0 * RENDER_SCALE,
        CHIP_RGB,
        1.0,
    );

    let glyph_box_x = if cfg!(windows) {
        (height - glyph_width) / 2.0
    } else {
        pad_left
    };
    let glyph_box_y = (height - glyph_width) / 2.0;
    draw_pulse(
        &mut canvas,
        glyph_box_x,
        glyph_box_y,
        glyph_width,
        2.0 * RENDER_SCALE,
    );

    if let (Some(font), Some(label)) = (&font, &label) {
        let baseline = (height + font_size * 0.72) / 2.0;
        let text_x = glyph_box_x + glyph_width + gap;
        draw_text(&mut canvas, font, font_size, text_x, baseline, label);
    }

    Some(RgbaImage {
        rgba: canvas.data,
        width: canvas.width,
        height: canvas.height,
    })
}

/// Advances for `text`, including kerning, at `font_size` pixels.
fn measure(font: &FontRef<'_>, font_size: f32, text: &str) -> f32 {
    let scaled = font.as_scaled(PxScale::from(font_size));
    let mut width = 0.0;
    let mut previous: Option<ab_glyph::GlyphId> = None;
    for character in text.chars() {
        let id = font.glyph_id(character);
        if let Some(previous) = previous {
            width += scaled.kern(previous, id);
        }
        width += scaled.h_advance(id);
        previous = Some(id);
    }
    width
}

fn draw_text(
    canvas: &mut Canvas,
    font: &FontRef<'_>,
    font_size: f32,
    x: f32,
    baseline: f32,
    text: &str,
) {
    let scaled = font.as_scaled(PxScale::from(font_size));
    let mut pen_x = x;
    let mut previous: Option<ab_glyph::GlyphId> = None;
    for character in text.chars() {
        let id = font.glyph_id(character);
        if let Some(previous) = previous {
            pen_x += scaled.kern(previous, id);
        }
        let glyph =
            id.with_scale_and_position(PxScale::from(font_size), ab_glyph::point(pen_x, baseline));
        if let Some(outline) = scaled.outline_glyph(glyph) {
            let bounds = outline.px_bounds();
            let origin_x = bounds.min.x.floor() as i32;
            let origin_y = bounds.min.y.floor() as i32;
            outline.draw(|dx, dy, coverage| {
                canvas.blend(
                    origin_x + dx as i32,
                    origin_y + dy as i32,
                    TEXT_RGB,
                    coverage,
                );
            });
        }
        pen_x += scaled.h_advance(id);
        previous = Some(id);
    }
}

/// Classic pulse line: flat, spike up, spike down, flat — scaled into a box.
fn draw_pulse(canvas: &mut Canvas, x: f32, y: f32, size: f32, thickness: f32) {
    let points = [
        (0.0, 0.62),
        (0.28, 0.62),
        (0.45, 0.12),
        (0.63, 0.95),
        (0.78, 0.62),
        (1.0, 0.62),
    ];
    let absolute: Vec<(f32, f32)> = points
        .iter()
        .map(|(px, py)| (x + px * size, y + py * size))
        .collect();
    for pair in absolute.windows(2) {
        canvas.stroke_segment(pair[0], pair[1], thickness, TEXT_RGB);
    }
}

/// Small RGBA raster surface. Anti-aliasing comes from 4x4 supersampling per
/// pixel, which is enough for these chip shapes and keeps the shape math local
/// instead of pulling a full rasterizer for a rounded rectangle and a polyline.
struct Canvas {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

impl Canvas {
    fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            data: vec![0; (width * height * 4) as usize],
        }
    }

    fn blend(&mut self, x: i32, y: i32, rgb: [u8; 3], coverage: f32) {
        if coverage <= 0.0 || x < 0 || y < 0 || x >= self.width as i32 || y >= self.height as i32 {
            return;
        }
        let index = ((y as u32 * self.width + x as u32) * 4) as usize;
        let source_alpha = coverage.clamp(0.0, 1.0);
        let destination_alpha = self.data[index + 3] as f32 / 255.0;
        let out_alpha = source_alpha + destination_alpha * (1.0 - source_alpha);
        if out_alpha <= 0.0 {
            return;
        }
        for (channel, source) in rgb.iter().enumerate() {
            let source = *source as f32;
            let destination = self.data[index + channel] as f32;
            let out = (source * source_alpha
                + destination * destination_alpha * (1.0 - source_alpha))
                / out_alpha;
            self.data[index + channel] = out.round().clamp(0.0, 255.0) as u8;
        }
        self.data[index + 3] = (out_alpha * 255.0).round().clamp(0.0, 255.0) as u8;
    }

    fn fill_rounded_rect(&mut self, rect: [f32; 4], radius: f32, rgb: [u8; 3], alpha: f32) {
        let [x0, y0, x1, y1] = rect;
        let radius = radius.min((x1 - x0) / 2.0).min((y1 - y0) / 2.0);
        for y in 0..self.height {
            for x in 0..self.width {
                let coverage = supersample(
                    |px, py| {
                        let core_x = px.clamp(x0 + radius, x1 - radius);
                        let core_y = py.clamp(y0 + radius, y1 - radius);
                        let dx = px - core_x;
                        let dy = py - core_y;
                        dx * dx + dy * dy <= radius * radius
                    },
                    x as f32,
                    y as f32,
                );
                self.blend(x as i32, y as i32, rgb, coverage * alpha);
            }
        }
    }

    fn stroke_segment(&mut self, from: (f32, f32), to: (f32, f32), thickness: f32, rgb: [u8; 3]) {
        let half = thickness / 2.0;
        let min_x = (from.0.min(to.0) - half).floor().max(0.0) as u32;
        let max_x = (from.0.max(to.0) + half)
            .ceil()
            .min(self.width as f32)
            .max(0.0) as u32;
        let min_y = (from.1.min(to.1) - half).floor().max(0.0) as u32;
        let max_y = (from.1.max(to.1) + half)
            .ceil()
            .min(self.height as f32)
            .max(0.0) as u32;
        for y in min_y..max_y {
            for x in min_x..max_x {
                let coverage = supersample(
                    |px, py| distance_to_segment((px, py), from, to) <= half,
                    x as f32,
                    y as f32,
                );
                self.blend(x as i32, y as i32, rgb, coverage);
            }
        }
    }
}

/// 4x4 subsample coverage of a predicate over pixel `(x, y)`.
fn supersample(predicate: impl Fn(f32, f32) -> bool, x: f32, y: f32) -> f32 {
    const STEPS: u32 = 4;
    let mut hits = 0;
    for row in 0..STEPS {
        for column in 0..STEPS {
            let px = x + (column as f32 + 0.5) / STEPS as f32;
            let py = y + (row as f32 + 0.5) / STEPS as f32;
            if predicate(px, py) {
                hits += 1;
            }
        }
    }
    hits as f32 / (STEPS * STEPS) as f32
}

fn distance_to_segment(point: (f32, f32), from: (f32, f32), to: (f32, f32)) -> f32 {
    let dx = to.0 - from.0;
    let dy = to.1 - from.1;
    let length_squared = dx * dx + dy * dy;
    let t = if length_squared <= f32::EPSILON {
        0.0
    } else {
        (((point.0 - from.0) * dx + (point.1 - from.1) * dy) / length_squared).clamp(0.0, 1.0)
    };
    let projection_x = from.0 + t * dx;
    let projection_y = from.1 + t * dy;
    ((point.0 - projection_x).powi(2) + (point.1 - projection_y).powi(2)).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_tokens_like_the_macos_build() {
        assert_eq!(format_tokens(0), "0");
        assert_eq!(format_tokens(7), "7");
        assert_eq!(format_tokens(1_500), "1.5K");
        assert_eq!(format_tokens(1_200_000), "1.2M");
        assert_eq!(format_tokens(999_950_000), "1B");
        assert_eq!(format_tokens(1_260_000_000), "1.3B");
        assert_eq!(format_tokens(2_000_000_000), "2B");
    }

    #[test]
    fn formats_cost_like_the_macos_build() {
        assert_eq!(format_cost(0.0), "$0");
        assert_eq!(format_cost(0.049), "$0");
        assert_eq!(format_cost(3.456), "$3.46");
        assert_eq!(format_cost(42.42), "$42.4");
        assert_eq!(format_cost(1234.0), "$1234");
    }

    #[test]
    fn summary_label_covers_missing_data() {
        assert_eq!(summary_label(None, None), "Today --");
        assert_eq!(
            summary_label(Some(1_200_000), Some(3.45)),
            "Today 1.2M · $3.45"
        );
        assert_eq!(summary_label(Some(500), None), "Today 500");
    }

    #[test]
    fn badge_has_visible_pixels_and_sane_proportions() {
        let badge = render_badge(Some(1_200_000)).expect("badge renders");
        assert!(badge.width >= badge.height);
        assert!(badge.height >= 40, "rendered at 2x for HiDPI panels");
        let opaque = badge.rgba.chunks(4).filter(|pixel| pixel[3] > 200).count();
        assert!(opaque > 200, "badge must contain the filled chip");
    }

    #[test]
    fn badge_without_tokens_still_renders() {
        let badge = render_badge(None).expect("badge renders without data");
        assert!(badge.rgba.chunks(4).any(|pixel| pixel[3] > 0));
    }
}
