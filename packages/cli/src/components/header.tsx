export function Header() {
  return (
    <box alignItems="center" justifyContent="center" >
      <box justifyContent="center" alignItems="center" flexDirection="row" gap={0.5}>
       <ascii-font font="tiny" text="Mo" color="gray" />
       <ascii-font font="tiny" text="Code" />
      </box>
    </box>
  );
}