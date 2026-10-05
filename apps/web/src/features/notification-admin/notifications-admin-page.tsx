import { PageHeader, TabsContent, TabsList, TabsRoot } from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { useSearchState } from '@/hooks/use-search-state';
import { DeliveriesPanel } from './deliveries-panel';
import { RulesPanel } from './rules-panel';
import { TemplatesPanel } from './templates-panel';

const TABS = [
  { value: 'templates', label: 'Templates' },
  { value: 'rules', label: 'Rules' },
  { value: 'deliveries', label: 'Delivery log' },
];

function NotificationsAdmin() {
  const [state, setState] = useSearchState({ tab: 'templates' });
  const tab = TABS.some((t) => t.value === state.tab) ? state.tab : 'templates';
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Control what people are told, who is told, and how. Changes apply to the next notification and are recorded in the audit log."
      />
      <TabsRoot value={tab} onValueChange={(v) => setState({ tab: v })}>
        <TabsList className="mb-6" items={TABS} />
        <TabsContent value="templates">
          <TemplatesPanel />
        </TabsContent>
        <TabsContent value="rules">
          <RulesPanel />
        </TabsContent>
        <TabsContent value="deliveries">
          <DeliveriesPanel />
        </TabsContent>
      </TabsRoot>
    </>
  );
}

export function NotificationsAdminPage() {
  return (
    <RequirePermission all={['notifications.manage']}>
      <NotificationsAdmin />
    </RequirePermission>
  );
}
