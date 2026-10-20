import UIKit

/// Manual entry shares the camera's validated lookup path; it cannot bypass a
/// bad check digit or reinterpret an ambiguous eight-digit string silently.
@MainActor enum FoodBarcodeEntry {
    static func present(from presenter: UIViewController, text: String = "", error: Bool = false,
                        completion: @escaping (String?) -> Void) {
        guard presenter.presentedViewController == nil else { completion(nil); return }
        let alert = UIAlertController(title: "Enter barcode", message: error
            ? "Check every digit, including the small digits at either end. The code did not pass its check digit."
            : "Enter all the digits printed under the barcode.", preferredStyle: .alert)
        alert.addTextField { field in
            field.text = text; field.keyboardType = .numberPad
            field.placeholder = "Barcode digits"; field.accessibilityIdentifier = "barcode-entry-digits"
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completion(nil) })
        alert.addAction(UIAlertAction(title: "Find product", style: .default) { [weak presenter, weak alert] _ in
            guard let presenter, let alert else { return }
            let value = alert.textFields?.first?.text ?? ""
            alert.dismiss(animated: true) {
                switch FoodBarcodeIdentity.manual(value) {
                case .accepted(let code): completion(code)
                case .chooseEightDigitFormat(let code): chooseFormat(from: presenter, code: code, completion: completion)
                case .invalid: present(from: presenter, text: String(value.prefix(64)), error: true, completion: completion)
                }
            }
        })
        presenter.present(alert, animated: true)
    }

    private static func chooseFormat(from presenter: UIViewController, code: String, completion: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: "Which barcode format?", message: "Eight digits can mean EAN-8 or a short UPC-E. Choose the format printed on the packaging. If unsure, use the camera or take a label photo.", preferredStyle: .alert)
        for (title, format) in [("EAN-8", FoodBarcodeIdentity.ManualFormat.ean8), ("UPC-E (short UPC)", .upce)] {
            alert.addAction(UIAlertAction(title: title, style: .default) { [weak presenter, weak alert] _ in
                guard let presenter, let alert else { return }
                alert.dismiss(animated: true) {
                    if case .accepted(let value) = FoodBarcodeIdentity.manual(code, format: format) { completion(value) }
                    else { present(from: presenter, text: code, error: true, completion: completion) }
                }
            })
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completion(nil) })
        presenter.present(alert, animated: true)
    }
}
