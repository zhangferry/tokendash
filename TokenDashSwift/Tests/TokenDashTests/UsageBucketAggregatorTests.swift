import XCTest
@testable import TokenDash

final class UsageBucketAggregatorTests: XCTestCase {
    private var formatter: DateFormatter {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        f.timeZone = TimeZone.current
        return f
    }

    private func blocks(_ starts: [String], tokens: Int = 100) -> BlocksResponse {
        BlocksResponse(blocks: starts.map {
            BlockEntry(startTime: $0, totalTokens: tokens)
        })
    }

    private func date(_ s: String) -> Date { formatter.date(from: s)! }

    private var now: Date { date("2026-09-01T14:07:00") }

    // MARK: - aggregate (5-minute base)

    func testAggregateProducesFiveMinuteBucketsOnAlignedGrid() {
        let resp = blocks(["2026-09-01T09:31:00", "2026-09-01T09:34:00", "2026-09-01T09:59:00"])
        let result = UsageBucketAggregator.aggregate([resp], now: now)
        XCTAssertTrue(result.granularityMatched, "sub-hour start times prove fine-grained data")
        let byStart = Dictionary(uniqueKeysWithValues: result.buckets.map { ($0.start, $0.tokens) })
        XCTAssertEqual(byStart[date("2026-09-01T09:30:00")], 200, "09:31 and 09:34 belong to the same 5-minute bucket")
        XCTAssertEqual(byStart[date("2026-09-01T09:55:00")], 100, "09:59 belongs to the 09:55 bucket")
        XCTAssertTrue(result.buckets.allSatisfy { $0.minutes == 5 })
    }

    func testAggregateKeepsCrossDayBuckets() {
        let lateNight = date("2026-09-02T00:07:00")
        let resp = blocks(["2026-09-01T22:33:00"])
        let result = UsageBucketAggregator.aggregate([resp], now: lateNight)
        XCTAssertTrue(result.buckets.contains {
            $0.start == date("2026-09-01T22:30:00") && $0.tokens == 100
        }, "The 48-hour base must retain previous-day 5-minute buckets for cross-day 3H views")
    }

    func testAggregateDetectsLegacyHourAlignedDaemon() {
        let resp = blocks(["2026-09-01T13:00:00", "2026-09-01T14:00:00"])
        let result = UsageBucketAggregator.aggregate([resp], now: now)
        XCTAssertFalse(result.granularityMatched, "Hour-aligned data indicates a legacy daemon ignored granularity")
    }

    func testAggregateEmptyWindowCountsAsMatched() {
        let result = UsageBucketAggregator.aggregate([blocks([])], now: now)
        XCTAssertTrue(result.granularityMatched, "An empty window cannot disprove granularity and must render as a matched zero line")
    }

    func testLegacyHourBucketsProducesTodaySkeleton() {
        let resp = blocks(["2026-09-01T09:00:00", "2026-08-31T23:00:00"])
        let buckets = UsageBucketAggregator.legacyHourBuckets([resp], now: now)
        XCTAssertEqual(buckets.count, 24)
        XCTAssertTrue(buckets.allSatisfy { $0.minutes == 60 })
        XCTAssertEqual(buckets[9].tokens, 100, "Today's 09:00 bucket must contain usage")
        XCTAssertFalse(buckets.contains { $0.start == date("2026-08-31T23:00:00") }, "Previous-day data must be excluded")
    }

    // MARK: - reaggregate (local range derivation)

    func testReaggregateTodayDerivesHourBucketsFromFiveMinuteBase() {
        let base = [
            TimeBucket(start: date("2026-09-01T09:05:00"), minutes: 5, tokens: 30, isPeak: false),
            TimeBucket(start: date("2026-09-01T09:25:00"), minutes: 5, tokens: 70, isPeak: false),
            TimeBucket(start: date("2026-09-01T10:45:00"), minutes: 5, tokens: 100, isPeak: false),
        ]
        let buckets = UsageBucketAggregator.reaggregate(base, to: .oneDay, now: now)
        XCTAssertEqual(buckets.count, 24, "The 1D view must contain a complete bucket skeleton")
        XCTAssertTrue(buckets.allSatisfy { $0.minutes == 60 })
        XCTAssertEqual(buckets[9].tokens, 100, "09:05 and 09:25 must merge into the 09:00 bucket")
        XCTAssertEqual(buckets[10].tokens, 100)
        XCTAssertEqual(buckets[14].tokens, 0, "Future hours must be zero")
    }

    func testReaggregateThreeHoursProducesCompleteFifteenMinWindow() {
        // 窗口 = [align(14:07−3h)=11:00, align(14:07)+15m=14:15)，13 桶完整覆盖
        let base = [
            TimeBucket(start: date("2026-09-01T11:30:00"), minutes: 5, tokens: 60, isPeak: false),
            TimeBucket(start: date("2026-09-01T11:40:00"), minutes: 5, tokens: 40, isPeak: false),
            TimeBucket(start: date("2026-09-01T14:00:00"), minutes: 5, tokens: 100, isPeak: false),
            TimeBucket(start: date("2026-09-01T10:55:00"), minutes: 5, tokens: 999, isPeak: false),
        ]
        let buckets = UsageBucketAggregator.reaggregate(base, to: .threeHours, now: now)
        XCTAssertEqual(buckets.count, 13, "Cover all 3 hours, including the bucket containing now−3h and the active final bucket")
        XCTAssertTrue(buckets.allSatisfy { $0.minutes == 15 })
        XCTAssertEqual(buckets.first?.start, date("2026-09-01T11:00:00"))
        XCTAssertEqual(buckets.last?.start, date("2026-09-01T14:00:00"))
        let byStart = Dictionary(uniqueKeysWithValues: buckets.map { ($0.start, $0.tokens) })
        XCTAssertEqual(byStart[date("2026-09-01T11:30:00")], 100, "11:30 and 11:40 must merge into 11:30; out-of-window 10:55 must be excluded")
        XCTAssertEqual(byStart[date("2026-09-01T14:00:00")], 100, "The current active bucket must be included")
    }

    func testReaggregateFifteenMinutesPassesThroughOneMinuteBuckets() {
        // 窗口 = [align(14:07−15m)=13:52, 14:08)，16 个 1min 桶
        let base = [
            TimeBucket(start: date("2026-09-01T13:57:00"), minutes: 1, tokens: 100, isPeak: false),
            TimeBucket(start: date("2026-09-01T13:52:00"), minutes: 1, tokens: 40, isPeak: false),
            TimeBucket(start: date("2026-09-01T14:30:00"), minutes: 1, tokens: 999, isPeak: false),
        ]
        let buckets = UsageBucketAggregator.reaggregate(base, to: .fifteenMinutes, now: now)
        XCTAssertEqual(buckets.count, 16, "Cover all 15 minutes, including the bucket containing now−15m and the active final bucket")
        XCTAssertTrue(buckets.allSatisfy { $0.minutes == 1 })
        XCTAssertEqual(buckets.first?.start, date("2026-09-01T13:52:00"))
        XCTAssertEqual(buckets.last?.start, date("2026-09-01T14:07:00"))
        let byStart = Dictionary(uniqueKeysWithValues: buckets.map { ($0.start, $0.tokens) })
        XCTAssertEqual(byStart[date("2026-09-01T13:57:00")], 100, "Out-of-window 14:30 must be excluded")
    }

    func testAggregateRealtimeWindowProducesOneMinuteBuckets() {
        let resp = blocks(["2026-09-01T14:03:00", "2026-09-01T14:04:00"])
        let result = UsageBucketAggregator.aggregate(
            [resp], now: now, bucketMinutes: 1,
            window: UsageBucketAggregator.realtimeWindow(now: now))
        XCTAssertTrue(result.granularityMatched)
        XCTAssertTrue(result.buckets.allSatisfy { $0.minutes == 1 })
        XCTAssertEqual(result.buckets.count, 16)
        let byStart = Dictionary(uniqueKeysWithValues: result.buckets.map { ($0.start, $0.tokens) })
        XCTAssertEqual(byStart[date("2026-09-01T14:03:00")], 100)
        XCTAssertEqual(byStart[date("2026-09-01T14:04:00")], 100)
    }

    func testReaggregateCrossDayThreeHourWindow() {
        // now = 凌晨 00:07，窗口 = [align(21:07)=21:00, 00:15)，跨到昨天
        let lateNight = date("2026-09-02T00:07:00")
        let base = [
            TimeBucket(start: date("2026-09-01T22:33:00"), minutes: 5, tokens: 100, isPeak: false),
        ]
        let buckets = UsageBucketAggregator.reaggregate(base, to: .threeHours, now: lateNight)
        XCTAssertEqual(buckets.first?.start, date("2026-09-01T21:00:00"))
        XCTAssertEqual(buckets.first { $0.tokens == 100 }?.start, date("2026-09-01T22:30:00"))
    }
}
