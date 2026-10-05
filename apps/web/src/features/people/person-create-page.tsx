import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Copy } from 'lucide-react';
import {
  Button,
  DialogContent,
  DialogRoot,
  Input,
  PageHeader,
  Panel,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { applyServerErrors } from '@/lib/forms';
import { useCreatePerson } from './api';
import { PersonForm, emptyPerson, toRequest } from './person-form';

const FIELDS = [
  'email',
  'firstName',
  'lastName',
  'employeeId',
  'jobTitle',
  'phone',
  'hiredAt',
  'locationId',
  'departmentId',
  'teamIds',
  'managerIds',
  'trainerIds',
  'roleIds',
];

function CreatePerson() {
  const navigate = useNavigate();
  const create = useCreatePerson();
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    id: string;
    name: string;
    activationUrl: string | null;
  } | null>(null);

  return (
    <>
      <PageHeader
        title="Add person"
        breadcrumbs={[{ label: 'People', to: '/people' }, { label: 'Add person' }]}
      />
      <Panel className="max-w-[860px]">
        <PersonForm
          mode="create"
          defaultValues={emptyPerson()}
          submitLabel="Add person"
          formError={formError}
          onCancel={() => navigate('/people')}
          onSubmit={async (values, setError) => {
            setFormError(null);
            try {
              const result = await create.mutateAsync({
                ...toRequest(values),
                roleIds: values.roleIds,
                sendInvitation: values.sendInvitation,
              });
              toast.success(
                `${result.user.displayName} was added`,
                values.sendInvitation ? 'Their invitation email is on its way.' : undefined,
              );
              if (result.activationUrl)
                setCreated({
                  id: result.user.id,
                  name: result.user.displayName,
                  activationUrl: result.activationUrl,
                });
              else navigate(`/people/${result.user.id}`);
            } catch (err) {
              setFormError(applyServerErrors(err, setError, FIELDS));
            }
          }}
        />
      </Panel>
      <DialogRoot
        open={Boolean(created)}
        onOpenChange={(open) => !open && created && navigate(`/people/${created.id}`)}
      >
        {created && (
          <DialogContent
            title="Invitation link"
            description="Email delivery is not configured in this environment. Share this one-time link with the new hire directly."
            footer={
              <Button variant="primary" onClick={() => navigate(`/people/${created.id}`)}>
                Done
              </Button>
            }
          >
            <div className="flex gap-2">
              <Input
                readOnly
                value={created.activationUrl ?? ''}
                className="font-mono text-sm"
                aria-label="Activation link"
              />
              <Button
                leading={<Copy className="size-4" />}
                onClick={() => {
                  void navigator.clipboard.writeText(created.activationUrl ?? '');
                  toast.success('Link copied');
                }}
              >
                Copy
              </Button>
            </div>
          </DialogContent>
        )}
      </DialogRoot>
    </>
  );
}

export function PersonCreatePage() {
  return (
    <RequirePermission all={['users.create', 'roles.assign']}>
      <CreatePerson />
    </RequirePermission>
  );
}
