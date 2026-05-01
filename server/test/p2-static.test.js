import assert from 'node:assert/strict'
import fs from 'node:fs'

const serviceSource = fs.readFileSync('server/domain/p2/service.ts', 'utf8')

assert.match(serviceSource, /WITH order_metrics AS/)
assert.match(serviceSource, /refund_metrics AS/)
assert.match(serviceSource, /CROSS JOIN refund_metrics/)
assert.match(serviceSource, /dwd_orders_fact_usd/)
assert.match(serviceSource, /o\.cs_bi_gmv_usd/)
assert.match(serviceSource, /o\.cs_bi_revenue_usd/)
assert.match(serviceSource, /o\.cs_bi_net_revenue_usd/)
assert.match(serviceSource, /COALESCE\(o\.is_regular_order, FALSE\) = TRUE/)
assert.match(
  serviceSource,
  /re\.refund_date BETWEEN DATE\(@date_from\) AND DATE\(@date_to\)/,
)
assert.doesNotMatch(serviceSource, /\bo\.gmv\b/)
assert.doesNotMatch(serviceSource, /revenue_after_all_discounts/)
assert.match(serviceSource, /ADR-0007/)

const shippingCostFilters = serviceSource.match(
  /NOT COALESCE\(li\.is_shipping_cost, FALSE\)/g,
)
assert.equal(shippingCostFilters?.length, 2)

console.log('P2 static SQL tests passed')
