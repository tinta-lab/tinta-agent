// Tinta Entity Abstraction — маппинг HA state → Tinta entity

export type TintaEntityType = 'light' | 'climate' | 'switch' | 'cover' | 'security' | 'sensor' | 'binary_sensor';

export interface TintaEntity {
  id: string;           // tinta entity id (e.g. "light.living_room")
  haEntityId: string;   // HA entity id (e.g. "light.wohnzimmer")
  type: TintaEntityType;
  name: string;
  state: string;
  attributes: Record<string, any>;
  lastChanged: string;
}

export function haStateToTintaEntity(haState: Record<string, any>): TintaEntity | null {
  const entityId: string = haState.entity_id;
  const domain = entityId.split('.')[0];

  const typeMap: Record<string, TintaEntityType> = {
    light: 'light',
    climate: 'climate',
    switch: 'switch',
    cover: 'cover',
    alarm_control_panel: 'security',
    sensor: 'sensor',
    binary_sensor: 'binary_sensor',
  };

  const type = typeMap[domain];
  if (!type) return null;

  return {
    id: `tinta.${entityId}`,
    haEntityId: entityId,
    type,
    name: haState.attributes?.friendly_name ?? entityId,
    state: haState.state,
    attributes: haState.attributes ?? {},
    lastChanged: haState.last_changed,
  };
}

export function buildHACommand(
  haEntityId: string,
  action: string,
  data: Record<string, any> = {},
): { domain: string; service: string; serviceData: Record<string, any> } {
  const domain = haEntityId.split('.')[0];

  switch (domain) {
    case 'light': {
      const service = action === 'on' ? 'turn_on' : action === 'off' ? 'turn_off' : action;
      return { domain: 'light', service, serviceData: { entity_id: haEntityId, ...data } };
    }
    case 'switch': {
      const service = action === 'on' ? 'turn_on' : action === 'off' ? 'turn_off' : action;
      return { domain: 'switch', service, serviceData: { entity_id: haEntityId } };
    }
    case 'climate': {
      return { domain: 'climate', service: action, serviceData: { entity_id: haEntityId, ...data } };
    }
    case 'cover': {
      const serviceMap: Record<string, string> = {
        open: 'open_cover', close: 'close_cover', stop: 'stop_cover', set_position: 'set_cover_position',
      };
      return { domain: 'cover', service: serviceMap[action] ?? action, serviceData: { entity_id: haEntityId, ...data } };
    }
    case 'alarm_control_panel': {
      return { domain: 'alarm_control_panel', service: action, serviceData: { entity_id: haEntityId, ...data } };
    }
    default:
      return { domain, service: action, serviceData: { entity_id: haEntityId, ...data } };
  }
}
