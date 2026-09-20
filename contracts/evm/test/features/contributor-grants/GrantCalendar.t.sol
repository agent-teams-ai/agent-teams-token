// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { TestBase } from "../../TestBase.sol";
import { GrantCalendar } from "../../../src/features/contributor-grants/GrantCalendar.sol";

contract GrantCalendarTest is TestBase {
    function check(uint64 start, uint64 cliff, uint64 end) external pure {
        GrantCalendar.validate(start, cliff, end);
    }

    function testGregorianUtcVectors() public pure {
        // Independent Gregorian datetime vectors, each preserving 12:34:56 UTC.
        // 2028-02-29 -> 2029-02-28 or 2029-03-01 -> 2032-02-29.
        GrantCalendar.validate(1_835_440_496, 1_866_976_496, 1_961_670_896);
        GrantCalendar.validate(1_835_440_496, 1_867_062_896, 1_961_670_896);
        // 2096-02-29 -> 2097 -> 2100 (century exception: 2100 is not leap).
        GrantCalendar.validate(3_981_357_296, 4_012_893_296, 4_107_501_296);
        GrantCalendar.validate(3_981_357_296, 4_012_979_696, 4_107_587_696);
        // March 1 must stay March 1 when the target year gains February 29.
        GrantCalendar.validate(1_803_904_496, 1_835_526_896, 1_930_134_896);
        GrantCalendar.validate(100, 31_536_100, 126_230_500);
    }

    function testRejectAcceleratedDriftAndMixedLeapConventions() public {
        vm.expectRevert(GrantCalendar.InvalidCalendarSchedule.selector);
        this.check(100, 112, 148);
        vm.expectRevert(GrantCalendar.InvalidCalendarSchedule.selector);
        this.check(1_835_440_496, 1_866_976_497, 1_961_670_896);
        vm.expectRevert(GrantCalendar.InvalidCalendarSchedule.selector);
        this.check(3_981_357_296, 4_012_893_296, 4_107_587_696);
        vm.expectRevert(GrantCalendar.InvalidCalendarSchedule.selector);
        this.check(253_276_070_400, 253_400_000_000, 253_500_000_000);
    }
}
