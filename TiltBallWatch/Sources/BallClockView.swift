import SwiftUI

struct BallClockView: View {
    @State private var model = BallModel()
    @Environment(\.isLuminanceReduced) private var dimmed

    var body: some View {
        TimelineView(.animation(paused: dimmed)) { timeline in
            Canvas { ctx, size in
                draw(ctx: &ctx, size: size, date: timeline.date)
            }
        }
        .background(Color.black)
        .ignoresSafeArea()
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }

    private func draw(ctx: inout GraphicsContext, size: CGSize, date: Date) {
        let cal = Calendar.current
        let c = cal.dateComponents([.hour, .minute, .second], from: date)
        let hh = String(format: "%02d", c.hour ?? 0)
        let mm = String(format: "%02d", c.minute ?? 0)
        let colonOn = (c.second ?? 0) % 2 == 0 || dimmed

        ctx.translateBy(x: size.width / 2, y: size.height / 2)

        // floor dots
        if !dimmed {
            let step = size.width / 7
            var gx = -size.width / 2 + step / 2
            while gx < size.width / 2 {
                var gy = -size.height / 2 + step / 2
                while gy < size.height / 2 {
                    ctx.fill(Path(ellipseIn: CGRect(x: gx - 1, y: gy - 1, width: 2, height: 2)),
                              with: .color(.white.opacity(0.07)))
                    gy += step
                }
                gx += step
            }
        }

        // date
        let dateText = date.formatted(.dateTime.month().day().weekday(.abbreviated).locale(Locale(identifier: "ja_JP")))
        ctx.draw(Text(dateText).font(.system(size: size.width * 0.085, weight: .medium)).foregroundColor(.white.opacity(0.55)),
                 at: CGPoint(x: 0, y: -size.height / 2 + size.height * 0.1), anchor: .center)

        // time
        let fontSize = size.width * 0.36
        let timeText = Text(hh).foregroundColor(.white)
            + Text(colonOn ? ":" : " ").foregroundColor(.orange)
            + Text(mm).foregroundColor(.white)
        let resolved = ctx.resolve(timeText.font(.system(size: fontSize, weight: .semibold).width(.condensed)))
        let ts = resolved.measure(in: size)
        let timeY = size.height * 0.04
        ctx.draw(resolved, at: CGPoint(x: 0, y: timeY), anchor: .center)
        let box = CGRect(x: -ts.width / 2 - 4, y: timeY - ts.height / 2 + ts.height * 0.12,
                         width: ts.width + 8, height: ts.height * 0.78)

        if dimmed { return }

        // seconds
        ctx.draw(Text(String(format: "%02d", c.second ?? 0)).font(.system(size: size.width * 0.09, weight: .medium).width(.condensed))
                    .foregroundColor(.white.opacity(0.55)),
                 at: CGPoint(x: 0, y: timeY + ts.height / 2 + size.height * 0.05), anchor: .center)

        // physics
        let r = size.width * 0.075
        model.step(now: date, size: size, box: box, radius: r)
        let p = model.pos

        // shadow
        var sh = ctx
        sh.translateBy(x: p.x + r * 0.25, y: p.y + r * 0.95)
        sh.scaleBy(x: 1, y: 0.42)
        let shRect = CGRect(x: -r * 1.35, y: -r * 1.35, width: r * 2.7, height: r * 2.7)
        sh.fill(Path(ellipseIn: shRect),
                with: .radialGradient(Gradient(colors: [.black.opacity(0.65), .clear]),
                                      center: .zero, startRadius: 2, endRadius: r * 1.35))

        // ball
        var b = ctx
        b.translateBy(x: p.x, y: p.y)
        let disc = Path(ellipseIn: CGRect(x: -r, y: -r, width: r * 2, height: r * 2))
        b.clip(to: disc)
        b.fill(disc, with: .color(Color(red: 1, green: 0.416, blue: 0.169)))
        for pt in model.points where pt.z > 0.05 {
            let rad = (pt.big ? 0.2 : 0.123) * r * (0.35 + 0.65 * pt.z)
            let squash = 0.4 + 0.6 * pt.z
            var d = b
            d.translateBy(x: pt.x * r, y: pt.y * r)
            d.rotate(by: .radians(atan2(pt.y, pt.x)))
            d.fill(Path(ellipseIn: CGRect(x: -rad, y: -rad * squash, width: rad * 2, height: rad * 2 * squash)),
                   with: .color(pt.big ? .white.opacity(0.92) : Color(red: 0.31, green: 0.08, blue: 0).opacity(0.45)))
        }
        b.fill(disc, with: .radialGradient(
            Gradient(stops: [
                .init(color: .white.opacity(0.55), location: 0),
                .init(color: .white.opacity(0), location: 0.35),
                .init(color: .black.opacity(0.25), location: 0.75),
                .init(color: .black.opacity(0.7), location: 1)]),
            center: CGPoint(x: -r * 0.35, y: -r * 0.4), startRadius: r * 0.1, endRadius: r * 1.05))
    }
}
