import assert from 'node:assert/strict'
import {
  ConfiguredLiveLogisticsClient,
  mapTrackingStatusToFeishuLogisticsStatus,
  normalizeFpxTrackingStatus,
  normalizeYunexpressTrackingStatus,
  resolveLiveLogisticsStatus,
} from '../integrations/live-logistics.js'

function testFpxStatusNormalizationUsesCarrierEvents() {
  assert.equal(
    normalizeFpxTrackingStatus({
      result: '1',
      data: JSON.stringify({
        trackingList: [
          { businessLinkCode: 'FPX_C_PICKUP', trackingContent: 'Shipment picked up' },
          { businessLinkCode: 'FPX_S_SIGNED', trackingContent: 'Delivered to front door' },
        ],
      }),
    }),
    'delivered',
  )

  assert.equal(
    normalizeFpxTrackingStatus({
      result: '1',
      data: {
        trackingList: [
          { businessLinkCode: 'FPX_I_RC', trackingContent: 'Held by customs' },
        ],
      },
    }),
    'customs',
  )
}

function testYunexpressStatusNormalizationReadsEvents() {
  assert.equal(
    normalizeYunexpressTrackingStatus({
      data: [
        {
          LatestEvent: { ProcessContent: 'Delivered, left at front door' },
          TrackDetails: [],
        },
      ],
    }),
    'delivered',
  )

  assert.equal(
    normalizeYunexpressTrackingStatus({
      data: [
        {
          TrackDetails: [{ ProcessContent: 'Delivery failed due to address issue' }],
        },
      ],
    }),
    'delivery_failed',
  )
}

function testMapsInternalStatusToTargetOptions() {
  assert.equal(mapTrackingStatusToFeishuLogisticsStatus('delivered'), '已签收')
  assert.equal(mapTrackingStatusToFeishuLogisticsStatus('delivery_failed', 'Package lost'), '丢包')
  assert.equal(mapTrackingStatusToFeishuLogisticsStatus('delivery_failed', 'Return to sender'), '发货已拦截')
  assert.equal(mapTrackingStatusToFeishuLogisticsStatus('delivery_failed'), '派送失败')
  assert.equal(mapTrackingStatusToFeishuLogisticsStatus('international'), '运输途中')
  assert.equal(mapTrackingStatusToFeishuLogisticsStatus('customs'), '运输途中')
  assert.equal(mapTrackingStatusToFeishuLogisticsStatus(''), null)
}

async function testResolveLiveLogisticsStatusSelectsProviderByCarrier() {
  const calls: string[] = []
  const result = await resolveLiveLogisticsStatus(
    {
      trackingNumber: '4PX123',
      carrier: '4PX',
      internalTrackingNumber: '4PX123',
    },
    {
      async queryFpx(input: { trackingNumber: string; internalTrackingNumber?: string | null }) {
        calls.push(`fpx:${input.trackingNumber}:${input.internalTrackingNumber}`)
        return {
          provider: 'fpx',
          lookup_status: 'success',
          logistics_status: 'delivered',
          raw: {},
        }
      },
    },
  )

  assert.equal(result.status, '已签收')
  assert.equal(result.provider, 'fpx')
  assert.deepEqual(calls, ['fpx:4PX123:4PX123'])
}

async function testConfiguredFpxClientProbesInternalAndDeliveryOrderNumbers() {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; body: string }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') })
    const payload = calls.length === 1
      ? { result: '1', data: JSON.stringify({ trackingList: [] }) }
      : {
          result: '1',
          data: JSON.stringify({
            trackingList: [
              { businessLinkCode: 'FPX_S_SIGNED', trackingContent: 'Delivered to front door' },
            ],
          }),
        }
    return new Response(JSON.stringify(payload), { status: 200 })
  }) as typeof fetch
  try {
    const client = new ConfiguredLiveLogisticsClient({
      logistics: {
        fpx: {
          app_key: 'app-key',
          app_secret: 'app-secret',
        },
      },
    } as never)

    const result = await client.queryFpx({
      trackingNumber: 'DELIVERY123',
      internalTrackingNumber: '4PX123',
    })

    assert.equal(result.lookup_status, 'success')
    assert.equal(result.logistics_status, 'delivered')
    assert.equal(calls.length, 2)
    assert.match(calls[0].url, /method=cs\.trs\.query\.orderNode/)
    assert.equal(calls[0].body, '{"fpxTrackingNo":"4PX123"}')
    assert.match(calls[1].url, /method=tr\.order\.tracking\.get/)
    assert.equal(calls[1].body, '{"deliveryOrderNo":"DELIVERY123"}')
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function run() {
  testFpxStatusNormalizationUsesCarrierEvents()
  testYunexpressStatusNormalizationReadsEvents()
  testMapsInternalStatusToTargetOptions()
  await testResolveLiveLogisticsStatusSelectsProviderByCarrier()
  await testConfiguredFpxClientProbesInternalAndDeliveryOrderNumbers()
  console.log('Live logistics tests passed')
}

await run()
