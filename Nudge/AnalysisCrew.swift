import UIKit

/// The existing articulated crew choreography, rendered with native layers for
/// the camera's barcode card. Every limb/eye uses the bundled original artwork;
/// animation never changes request state or reports completed work.
@MainActor
final class AnalysisCrewView: UIView {
    private final class Stage: UIView {
        var didLayout: (() -> Void)?
        override func layoutSubviews() { super.layoutSubviews(); didLayout?() }
    }
    private let stage = Stage()
    private let artwork = CALayer()
    private let pauseButton = NudgeButton("Pause animation", variant: .secondary)
    private var userPaused = false
    private var backgrounded = false
    private var reducedMotion: Bool
    private(set) var animationRunning = false
    private(set) var assetAvailable = false
    var onPauseChanged: ((Bool) -> Void)?

    init(reducedMotion: Bool = UIAccessibility.isReduceMotionEnabled) {
        self.reducedMotion = reducedMotion
        super.init(frame: .zero)
        accessibilityIdentifier = "analysis-crew"
        stage.backgroundColor = NudgeTheme.selectedSurface
        stage.layer.cornerRadius = 20
        stage.clipsToBounds = true
        stage.isAccessibilityElement = false
        stage.accessibilityElementsHidden = true
        stage.layer.addSublayer(artwork)
        stage.didLayout = { [weak self] in self?.layoutArtwork() }
        pauseButton.accessibilityIdentifier = "analysis-crew-pause"
        pauseButton.addAction(UIAction { [weak self] _ in self?.togglePause() }, for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [stage, pauseButton])
        stack.axis = .vertical; stack.spacing = 10; stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stage.heightAnchor.constraint(equalTo: stage.widthAnchor, multiplier: 210.0 / 360)
        ])
        createArtwork()
        NotificationCenter.default.addObserver(self, selector: #selector(motionChanged), name: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didForeground), name: UIApplication.didBecomeActiveNotification, object: nil)
        updateMotion()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { NotificationCenter.default.removeObserver(self) }
    override func layoutSubviews() {
        super.layoutSubviews()
        layoutArtwork()
    }
    private func layoutArtwork() {
        // UIStackView resolves the stage after its parent's layout pass. Scale
        // again from the stage callback so the original layers cannot stay at 0.
        guard stage.bounds.width > 0 else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        artwork.bounds = CGRect(x: 0, y: 0, width: 360, height: 210)
        artwork.position = CGPoint(x: stage.bounds.midX, y: stage.bounds.midY)
        artwork.setAffineTransform(CGAffineTransform(scaleX: stage.bounds.width / 360, y: stage.bounds.width / 360))
        CATransaction.commit()
    }
    override func didMoveToWindow() { super.didMoveToWindow(); updateMotion() }
    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if previousTraitCollection?.userInterfaceStyle != traitCollection.userInterfaceStyle { updateDecorationColors() }
    }
    @objc private func motionChanged() { setReducedMotion(UIAccessibility.isReduceMotionEnabled) }
    @objc private func didBackground() { setBackgrounded(true) }
    @objc private func didForeground() { setBackgrounded(false) }
    func setReducedMotion(_ enabled: Bool) { reducedMotion = enabled; updateMotion() }
    func setBackgrounded(_ hidden: Bool) { backgrounded = hidden; updateMotion() }
    func togglePause() { guard !reducedMotion else { return }; userPaused.toggle(); updateMotion(); onPauseChanged?(userPaused) }
    private func updateMotion() {
        let shouldRun = assetAvailable && window != nil && !backgrounded && !reducedMotion && !userPaused
        if shouldRun && artwork.speed == 0 {
            let paused = artwork.timeOffset
            artwork.speed = 1; artwork.timeOffset = 0; artwork.beginTime = 0
            artwork.beginTime = artwork.convertTime(CACurrentMediaTime(), from: nil) - paused
        } else if !shouldRun && artwork.speed != 0 {
            artwork.timeOffset = artwork.convertTime(CACurrentMediaTime(), from: nil); artwork.speed = 0
        }
        animationRunning = shouldRun
        pauseButton.isEnabled = !reducedMotion && assetAvailable
        pauseButton.configuration?.title = reducedMotion ? "Animation off · Reduce Motion" : userPaused ? "Resume animation" : "Pause animation"
        pauseButton.accessibilityLabel = reducedMotion ? "Animation off. Reduce Motion is enabled." : userPaused ? "Resume animation" : "Pause animation"
        pauseButton.accessibilityValue = userPaused || reducedMotion ? "Paused. Analysis continues." : "Playing. Analysis continues."
        if userPaused { pauseButton.accessibilityTraits.insert(.selected) } else { pauseButton.accessibilityTraits.remove(.selected) }
    }
    private func createArtwork() {
        guard let url = Bundle.main.url(forResource: "nudge", withExtension: "png", subdirectory: "Web/assets"),
              let image = UIImage(contentsOfFile: url.path)?.cgImage else { return }
        assetAvailable = true
        for frame in [CGRect(x: 38, y: 125, width: 300, height: 16), CGRect(x: 9, y: 168, width: 344, height: 20)] {
            let floor = CAShapeLayer(); floor.name = "crew-floor"; floor.path = UIBezierPath(ovalIn: frame).cgPath; artwork.addSublayer(floor)
        }
        for (index, x) in [28.0, 132.0, 241.0, 229.0].enumerated() {
            let actor = CALayer(); actor.name = "crew-actor-\(index)"; actor.bounds = CGRect(x: 0, y: 0, width: 84, height: 84)
            actor.anchorPoint = .zero; actor.position = CGPoint(x: x, y: index == 3 ? 51 : 95)
            if index == 3 { actor.setAffineTransform(CGAffineTransform(scaleX: 0.7, y: 0.7)) }
            artwork.addSublayer(actor)
            let pose = CALayer(); pose.frame = actor.bounds; actor.addSublayer(pose)
            func part(_ name: String, _ points: [CGPoint], pivot: CGPoint? = nil) -> CALayer {
                let layer = CALayer(); layer.name = name; layer.frame = actor.bounds; layer.contents = image
                let path = UIBezierPath(); for (i, p) in points.enumerated() { let q = CGPoint(x: p.x * 84 / 1280, y: p.y * 84 / 1280); if i == 0 { path.move(to: q) } else { path.addLine(to: q) } }; path.close()
                let mask = CAShapeLayer(); mask.path = path.cgPath; layer.mask = mask
                if let pivot { layer.anchorPoint = CGPoint(x: pivot.x / 1280, y: pivot.y / 1280); layer.position = CGPoint(x: pivot.x * 84 / 1280, y: pivot.y * 84 / 1280) }
                pose.addSublayer(layer); return layer
            }
            func points(_ coords: [CGFloat]) -> [CGPoint] { stride(from: 0, to: coords.count, by: 2).map { CGPoint(x: coords[$0], y: coords[$0 + 1]) } }
            let leftFoot = part("crew-left-foot", points([330,1022,630,1022,630,1208,330,1208]), pivot: CGPoint(x:493,y:1050))
            let rightFoot = part("crew-right-foot", points([635,1003,1010,1003,1010,1208,635,1208]), pivot: CGPoint(x:770,y:1040))
            _ = part("crew-body", points([270,605,254,413,397,276,365,78,691,61,712,274,912,310,949,463,976,672,939,981,833,1043,594,1050,444,1039,354,945,354,667]))
            let leftArm = part("crew-left-arm", points([267,601,359,667,371,914,319,1006,189,1001,132,940,131,796]), pivot: CGPoint(x:330,y:675))
            let rightArm = part("crew-right-arm", points([941,304,1211,302,1220,642,968,750,952,634,942,467]), pivot: CGPoint(x:963,y:656))
            for (eye, rect) in [CGRect(x:412,y:463,width:216,height:244),CGRect(x:707,y:406,width:182,height:212)].enumerated() {
                let lid = CAShapeLayer(); lid.name = "crew-blink"; lid.path = UIBezierPath(ovalIn: rect.applying(CGAffineTransform(scaleX: 84.0/1280, y: 84.0/1280))).cgPath
                // Original character eyelid colours, not application chrome.
                lid.fillColor = UIColor(red: eye == 0 ? 170.0/255 : 178.0/255, green: eye == 0 ? 112.0/255 : 124.0/255, blue: eye == 0 ? 239.0/255 : 243.0/255, alpha: 1).cgColor; lid.opacity = 0
                pose.addSublayer(lid)
                animate(lid, key: "opacity", values: [0,0,1,1,0,0], times: [0,0.43,0.44,0.46,0.47,1], duration: 4.1, delay: Double(index) * 0.9)
            }
            if index != 1 {
                let card = CAShapeLayer(); card.name = "crew-paper"; card.path = UIBezierPath(roundedRect: CGRect(x:45,y:46,width:29,height:22), cornerRadius:3).cgPath; card.lineWidth = 1.5; pose.addSublayer(card)
                let lines = CAShapeLayer(); lines.name = "crew-paper-lines"; let path = UIBezierPath()
                for (y,width) in [(52.0,19.0),(57.0,13.0),(62.0,16.0)] { path.move(to:CGPoint(x:50,y:y));path.addLine(to:CGPoint(x:50+width,y:y)) }; lines.path = path.cgPath; lines.lineWidth = 1.4; pose.addSublayer(lines)
            }
            animate(leftArm, key:"transform.rotation.z", values:[-0.09,0.12,-0.09], duration:1)
            animate(rightArm, key:"transform.rotation.z", values:[0.12,-0.09,0.12], duration:1)
            animate(leftFoot, key:"transform.rotation.z", values:[-0.09,0.09,-0.09], duration:0.64)
            animate(rightFoot, key:"transform.rotation.z", values:[0.09,-0.09,0.09], duration:0.64)
            animate(leftFoot, key:"transform.translation.y", values:[-0.7,0,-0.7], duration:0.64)
            animate(rightFoot, key:"transform.translation.y", values:[0,-0.7,0], duration:0.64)
            if index == 0 {
                animate(actor,key:"position.x",values:[5,5,108,98,107,107,109,109,5],times:[0,0.08,0.27,0.31,0.37,0.62,0.78,0.86,1],duration:9)
                animate(pose,key:"transform.rotation.z",values:[0,0,0.12,-0.21,-1.06,-1.06,-0.52,0,0],times:[0,0.24,0.27,0.31,0.37,0.55,0.66,0.78,1],duration:9)
            } else if index == 1 {
                animate(actor,key:"position.x",values:[241,241,177,187,207,247,250,241],times:[0,0.08,0.27,0.31,0.38,0.73,0.86,1],duration:9)
                animate(pose,key:"transform.rotation.z",values:[0,0,-0.14,0.23,0,0],times:[0,0.24,0.27,0.32,0.4,1],duration:9)
            } else if index == 2 {
                animate(actor,key:"position.x",values:[270,270,174,174,225,270],times:[0,0.4,0.6,0.74,0.85,1],duration:9)
                animate(pose,key:"transform.rotation.z",values:[0,0,-0.30,-0.30,-0.12,0],times:[0,0.51,0.61,0.69,0.75,1],duration:9)
            } else { animate(actor,key:"position.x",values:[245,15,15,245],times:[0,0.43,0.53,1],duration:9) }
        }
        updateDecorationColors()
    }
    private func animate(_ layer: CALayer, key: String, values: [Double], times: [Double]? = nil, duration: Double, delay: Double = 0) {
        let animation = CAKeyframeAnimation(keyPath:key); animation.values = values
        animation.keyTimes = times?.map(NSNumber.init(value:)); animation.duration = duration
        animation.beginTime = CACurrentMediaTime() + delay; animation.repeatCount = .infinity
        animation.calculationMode = .linear; layer.add(animation,forKey:key)
    }
    private func updateDecorationColors() {
        func visit(_ layer: CALayer) {
            if let shape = layer as? CAShapeLayer {
                switch shape.name {
                case "crew-floor": shape.fillColor = NudgeTheme.progressFill.withAlphaComponent(0.16).resolvedColor(with:traitCollection).cgColor
                case "crew-paper": shape.fillColor = NudgeTheme.surface.resolvedColor(with:traitCollection).cgColor; shape.strokeColor = NudgeTheme.accent.resolvedColor(with:traitCollection).cgColor
                case "crew-paper-lines": shape.fillColor = UIColor.clear.cgColor; shape.strokeColor = NudgeTheme.accent.resolvedColor(with:traitCollection).cgColor
                default: break
                }
            }
            layer.sublayers?.forEach(visit)
        }
        visit(artwork)
    }
}
