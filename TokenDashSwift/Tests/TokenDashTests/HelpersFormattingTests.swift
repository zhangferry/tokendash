import XCTest
@testable import TokenDash

final class HelpersFormattingTests: XCTestCase {
    func testFormatTokensUsesBillionsAtOneThousandMillion() {
        XCTAssertEqual(formatTokens(1_000_000_000), "1B")
        XCTAssertEqual(formatTokens(1_500_000_000), "1.5B")
        XCTAssertEqual(formatTokens(2_000_000_000), "2B")
        XCTAssertEqual(formatTokens(999_950_000), "1B")
    }

    func testDateLabelsUseEnglishMonthAndWeekdayNames() {
        XCTAssertEqual(weekdayShort("2026-11-05"), "Thu")
        XCTAssertEqual(shortDate("2026-11-05"), "Nov 5")
        XCTAssertNotNil(todayLabel().range(
            of: #"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{2}:\d{2}$"#,
            options: .regularExpression))
    }

    func testLongResetCountdownUsesAnEnglishDate() {
        let future = Date().addingTimeInterval(10 * 24 * 60 * 60)
        let iso = ISO8601DateFormatter().string(from: future)
        let label = formatResetCountdown(iso)
        XCTAssertNotNil(label?.range(
            of: #"^on (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}$"#,
            options: .regularExpression))
    }
}
