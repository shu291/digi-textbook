import CoreMotion
import CoreGraphics
import Foundation

struct SpherePoint {
    var x: Double, y: Double, z: Double
    var big: Bool
}

/// Physics + rolling-sphere state. Plain class (not observable): the Canvas steps it every frame.
final class BallModel {
    // position / velocity relative to the arena centre, in points
    var pos = CGPoint(x: 0, y: 40)
    var vel = CGVector(dx: 0, dy: 0)
    var points: [SpherePoint] = {
        let n = 70
        return (0..<n).map { i in
            let y = 1 - 2 * (Double(i) + 0.5) / Double(n)
            let r = (1 - y * y).squareRoot()
            let a = Double(i) * 2.39996323
            return SpherePoint(x: cos(a) * r, y: y, z: sin(a) * r, big: i % 7 == 0)
        }
    }()

    private let motion = CMMotionManager()
    private var gravity = (x: 0.0, y: 0.0)
    private var last: Date?
    private let restitution = 0.55

    func start() {
        guard motion.isDeviceMotionAvailable, !motion.isDeviceMotionActive else { return }
        motion.deviceMotionUpdateInterval = 1.0 / 60.0
        motion.startDeviceMotionUpdates(to: .main) { [weak self] m, _ in
            guard let g = m?.gravity else { return }
            self?.gravity = (g.x, g.y)
        }
    }

    func stop() {
        motion.stopDeviceMotionUpdates()
        last = nil
    }

    /// Advance the simulation. `size` is the arena, `box` the time text rect relative to the centre.
    func step(now: Date, size: CGSize, box: CGRect, radius r: CGFloat) {
        defer { last = now }
        guard let last else { return }
        let dt = min(now.timeIntervalSince(last), 1.0 / 30.0)
        guard dt > 0 else { return }

        // Tilt the top edge down -> gravity.y > 0 -> ball moves up (screen -y).
        let ax = gravity.x * Double(size.width) * 8
        let ay = -gravity.y * Double(size.width) * 8

        let sub = 3
        let h = dt / Double(sub)
        for _ in 0..<sub {
            vel.dx += CGFloat(ax * h)
            vel.dy += CGFloat(ay * h)
            let f = CGFloat(max(0, 1 - 0.7 * h))
            vel.dx *= f; vel.dy *= f
            let old = pos
            pos.x += vel.dx * CGFloat(h)
            pos.y += vel.dy * CGFloat(h)
            collideWalls(size: size, r: r)
            collideBox(box, r: r)
            collideWalls(size: size, r: r)
            roll(dx: Double(pos.x - old.x), dy: Double(pos.y - old.y), r: Double(r))
        }
    }

    private func collideWalls(size: CGSize, r: CGFloat) {
        let e = CGFloat(restitution)
        let ihx = size.width / 2 - r, ihy = size.height / 2 - r
        let icr = min(size.width, size.height) * 0.24 - r
        if pos.x > ihx { pos.x = ihx; if vel.dx > 0 { vel.dx *= -e } }
        else if pos.x < -ihx { pos.x = -ihx; if vel.dx < 0 { vel.dx *= -e } }
        if pos.y > ihy { pos.y = ihy; if vel.dy > 0 { vel.dy *= -e } }
        else if pos.y < -ihy { pos.y = -ihy; if vel.dy < 0 { vel.dy *= -e } }
        let cx = ihx - icr, cy = ihy - icr
        let qx = abs(pos.x) - cx, qy = abs(pos.y) - cy
        if qx > 0 && qy > 0 {
            let d = (qx * qx + qy * qy).squareRoot()
            if d > icr {
                let nx = (pos.x < 0 ? -1 : 1) * qx / d
                let ny = (pos.y < 0 ? -1 : 1) * qy / d
                pos.x -= nx * (d - icr); pos.y -= ny * (d - icr)
                let vn = vel.dx * nx + vel.dy * ny
                if vn > 0 { vel.dx -= (1 + e) * vn * nx; vel.dy -= (1 + e) * vn * ny }
            }
        }
    }

    private func collideBox(_ b: CGRect, r: CGFloat) {
        let px = min(max(pos.x, b.minX), b.maxX)
        let py = min(max(pos.y, b.minY), b.maxY)
        let dx = pos.x - px, dy = pos.y - py
        let d = (dx * dx + dy * dy).squareRoot()
        if d >= r { return }
        var nx: CGFloat, ny: CGFloat
        if d > 0 {
            nx = dx / d; ny = dy / d
            pos.x = px + nx * r; pos.y = py + ny * r
        } else {
            // centre inside the box: leave through the nearest side
            let l = pos.x - b.minX, rr = b.maxX - pos.x, t = pos.y - b.minY, bt = b.maxY - pos.y
            let m = min(l, rr, t, bt)
            nx = m == l ? -1 : (m == rr ? 1 : 0)
            ny = m == t ? -1 : (m == bt ? 1 : 0)
            pos.x += nx * (m + r); pos.y += ny * (m + r)
        }
        let vn = vel.dx * nx + vel.dy * ny
        if vn < 0 {
            vel.dx -= 1.5 * vn * nx
            vel.dy -= 1.5 * vn * ny
        }
    }

    /// Rotate surface points as the ball rolls by (dx, dy).
    private func roll(dx: Double, dy: Double, r: Double) {
        let d = (dx * dx + dy * dy).squareRoot()
        guard d > 1e-6 else { return }
        let th = d / r
        let ax = -dy / d, ay = dx / d
        let c = cos(th), s = sin(th)
        for i in points.indices {
            var p = points[i]
            let dot = ax * p.x + ay * p.y
            let cx = ay * p.z, cy = -ax * p.z, cz = ax * p.y - ay * p.x
            p.x = p.x * c + cx * s + ax * dot * (1 - c)
            p.y = p.y * c + cy * s + ay * dot * (1 - c)
            p.z = p.z * c + cz * s
            let l = (p.x * p.x + p.y * p.y + p.z * p.z).squareRoot()
            p.x /= l; p.y /= l; p.z /= l
            points[i] = p
        }
    }
}
