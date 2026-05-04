import type { SyncConfig } from './sync-config.js'

type ShopifyMoney = {
  amount?: string | null
  currencyCode?: string | null
}

type ShopifyLineItem = {
  sku: string | null
  quantity: number
  originalUnitPrice: ShopifyMoney | null
  originalTotal: ShopifyMoney | null
}

type ShopifyTrackingInfo = {
  company: string | null
  number: string
  url: string | null
}

export type ShopifyShipment = {
  id: string | null
  status: string | null
  display_status: string | null
  created_at: string | null
  tracking: ShopifyTrackingInfo[]
}

export type ShopifyOrder = {
  id: string
  name: string
  customer_name: string
  customer_email: string
  order_date: string | null
  order_amount: string | null
  currency: string | null
  fulfillment_status: string | null
  tracking_numbers: string[]
  shipments: ShopifyShipment[]
  shipped_at: string | null
  admin_order_url: string
  line_items: ShopifyLineItem[]
}

type ShopifyQueryResponse = {
  data?: {
    orders?: {
      edges?: Array<{
        node?: {
          id?: string | null
          name?: string | null
          createdAt?: string | null
          processedAt?: string | null
          displayFulfillmentStatus?: string | null
          email?: string | null
          customer?: {
            displayName?: string | null
            email?: string | null
          } | null
          currentTotalPriceSet?: {
            shopMoney?: ShopifyMoney | null
          } | null
          lineItems?: {
            edges?: Array<{
              node?: {
                sku?: string | null
                quantity?: number | null
                originalUnitPriceSet?: {
                  shopMoney?: ShopifyMoney | null
                } | null
                originalTotalSet?: {
                  shopMoney?: ShopifyMoney | null
                } | null
              } | null
            }>
          } | null
          fulfillments?: Array<{
            id?: string | null
            trackingInfo?: Array<{
              company?: string | null
              number?: string | null
              url?: string | null
            }> | null
            createdAt?: string | null
            status?: string | null
            displayStatus?: string | null
          }> | null
        } | null
      }>
    }
  }
  errors?: Array<{ message?: string }>
}

export type ShopifyLikeClient = {
  fetchOrder(orderNo: string): Promise<ShopifyOrder | null>
}

type ShopifySites = NonNullable<SyncConfig['shopify']>['sites']

const ORDER_QUERY = `
query OrderByName($query: String!) {
  orders(first: 1, query: $query) {
    edges {
      node {
        id
        name
        createdAt
        processedAt
        displayFulfillmentStatus
        email
        customer {
          displayName
          email
        }
        currentTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        lineItems(first: 100) {
          edges {
            node {
              sku
              quantity
              originalUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              originalTotalSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
        fulfillments(first: 20) {
          id
          trackingInfo {
            company
            number
            url
          }
          createdAt
          status
          displayStatus
        }
      }
    }
  }
}
`

function normalizeSku(value: string | null | undefined) {
  return String(value ?? '').trim().toUpperCase()
}

function firstNonEmpty(values: Array<string | null | undefined>) {
  return values.find((value) => String(value ?? '').trim()) ?? null
}

function toAdminBaseUrl(graphqlUrl: string) {
  return graphqlUrl.replace(/\/admin\/api\/[^/]+\/graphql\.json$/i, '/admin/orders')
}

export function resolveShopifySiteKey(orderNo: string): keyof ShopifySites | null {
  const upper = orderNo.trim().toUpperCase()
  if (upper.startsWith('LUK')) {
    return 'uk'
  }
  if (upper.startsWith('LFR')) {
    return 'fr'
  }
  if (upper.startsWith('LC')) {
    return 'lc'
  }
  return null
}

export function inferLogisticsStatusFromShopify(fulfillmentStatus: string | null): string | null {
  if (!fulfillmentStatus) {
    return null
  }

  const normalized = fulfillmentStatus.trim().toUpperCase()
  if (normalized === 'UNFULFILLED') {
    return '未发货'
  }
  if (normalized === 'ON_HOLD') {
    return '未知状态'
  }
  return null
}

export function isProductLineItem(sku: string | null) {
  const normalized = normalizeSku(sku)
  if (!normalized) {
    return false
  }
  return normalized !== 'INSURE02' && normalized !== 'SHIPPINGCOST'
}

export function matchSkuAmount(order: ShopifyOrder, complaintSku: string | null) {
  const normalizedComplaintSku = normalizeSku(complaintSku)
  const productLineItems = order.line_items.filter((lineItem) => isProductLineItem(lineItem.sku))

  if (normalizedComplaintSku) {
    const matched = productLineItems.find((lineItem) => normalizeSku(lineItem.sku) === normalizedComplaintSku)
    return matched?.originalTotal?.amount ?? matched?.originalUnitPrice?.amount ?? null
  }

  if (productLineItems.length === 1) {
    const [lineItem] = productLineItems
    return lineItem.originalTotal?.amount ?? lineItem.originalUnitPrice?.amount ?? null
  }

  return null
}

export class ShopifyClient implements ShopifyLikeClient {
  constructor(private readonly config: NonNullable<SyncConfig['shopify']>) {}

  async fetchOrder(orderNo: string): Promise<ShopifyOrder | null> {
    const siteKey = resolveShopifySiteKey(orderNo)
    if (!siteKey) {
      return null
    }

    const site = this.config.sites[siteKey]
    if (!site) {
      return null
    }

    const response = await fetch(site.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': site.token,
      },
      body: JSON.stringify({
        query: ORDER_QUERY,
        variables: {
          query: `name:${orderNo}`,
        },
      }),
    })

    const payload = (await response.json()) as ShopifyQueryResponse
    if (!response.ok) {
      throw new Error(`Shopify request failed for ${orderNo}: ${response.status}`)
    }
    if (payload.errors?.length) {
      throw new Error(
        `Shopify query error for ${orderNo}: ${payload.errors.map((error) => error.message).filter(Boolean).join('; ')}`,
      )
    }

    const node = payload.data?.orders?.edges?.[0]?.node
    if (!node?.id || !node.name) {
      return null
    }

    const lineItems: ShopifyLineItem[] =
      node.lineItems?.edges
        ?.map((edge) => edge.node)
        .filter((lineItem): lineItem is NonNullable<typeof lineItem> => Boolean(lineItem))
        .map((lineItem) => ({
          sku: lineItem.sku ?? null,
          quantity: Number(lineItem.quantity ?? 0),
          originalUnitPrice: lineItem.originalUnitPriceSet?.shopMoney ?? null,
          originalTotal: lineItem.originalTotalSet?.shopMoney ?? null,
        })) ?? []

    const trackingNumbers = [
      ...new Set(
        (node.fulfillments ?? [])
          .flatMap((fulfillment) => fulfillment.trackingInfo ?? [])
          .map((tracking) => String(tracking.number ?? '').trim())
          .filter(Boolean),
      ),
    ]
    const shipments: ShopifyShipment[] = (node.fulfillments ?? []).map((fulfillment) => ({
      id: fulfillment.id ?? null,
      status: fulfillment.status ?? null,
      display_status: fulfillment.displayStatus ?? null,
      created_at: fulfillment.createdAt ?? null,
      tracking:
        fulfillment.trackingInfo
          ?.map((tracking) => ({
            company: tracking.company ?? null,
            number: String(tracking.number ?? '').trim(),
            url: tracking.url ?? null,
          }))
          .filter((tracking) => tracking.number) ?? [],
    }))

    const shippedAt = firstNonEmpty((node.fulfillments ?? []).map((fulfillment) => fulfillment.createdAt ?? null))
    const orderId = node.id.split('/').pop() ?? node.id

    return {
      id: node.id,
      name: node.name,
      customer_name: firstNonEmpty([node.customer?.displayName, node.customer?.email, node.email]) ?? '',
      customer_email: firstNonEmpty([node.customer?.email, node.email]) ?? '',
      order_date: firstNonEmpty([node.processedAt, node.createdAt]),
      order_amount: node.currentTotalPriceSet?.shopMoney?.amount ?? null,
      currency: node.currentTotalPriceSet?.shopMoney?.currencyCode ?? null,
      fulfillment_status: node.displayFulfillmentStatus ?? null,
      tracking_numbers: trackingNumbers,
      shipments,
      shipped_at: shippedAt,
      admin_order_url: `${toAdminBaseUrl(site.url)}/${orderId}`,
      line_items: lineItems,
    }
  }
}
